# Harness Sessions v1

This is the contract for native PTY harness sessions added beside AI Sessions v1.

## Authority path

```text
authenticated browser
  → Web (SQLite writer; harness_definitions; native-pty ai_sessions)
    → Agent `/v1/harness-sessions/start|resume`
      → exclusive home lease + slot materialize when dedicated-home
        → Docker exec PTY of structured argv
```

Browser payloads contain only DevSpace IDs (`workspaceId`, `sessionId`, `harnessId`). They
must not contain native session IDs, host paths, env maps, or shell strings.

## Argv

Launch and resume are `{ executable, args[] }`. Resume classification:

- `resume` null: not resumable
- zero `{sessionId}` tokens: provider-handled resume
- one whole-token `{sessionId}`: ID-based resume when a real native ID is stored privately
- otherwise: invalid definition

## Built-in Codex lifecycle

The built-in Codex preset uses `--no-daemon` for both launch and resume. Its `CODEX_HOME`
is an exclusive private slot leased only for the lifetime of the admitted native harness
generation. A detached Codex app-server daemon or updater could continue changing that slot
after the foreground TUI exits and DevSpace releases the lease, so detached provider daemons
are incompatible with this dedicated-home lifecycle. Normal Codex session data remains in the
home and is discovered for later native resume; daemon runtime state is ephemeral and is not
needed to restore the conversation. This contract applies to the built-in Codex preset and is
not automatically imposed on arbitrary custom harness argv.

## Codex native conversation identity

Codex conversation identity comes from an actual rollout's canonical `session_meta` record:
the Agent validates and stores `payload.id`, together with the record's workspace-compatible
`payload.cwd` and root-thread metadata. Rollout filenames, including the UUID suffix in a
`rollout-...jsonl` basename, are never native IDs. `session_index.jsonl` is supporting provider
metadata and is not an independent identity authority.

Before a new DevSpace Codex generation starts, the Agent records a private baseline of the
existing canonical thread IDs. On settlement it binds the DevSpace session only when exactly
one new root rollout for `/workspace` exists. Once bound, later generations retain that same
thread ID and settlement verifies it still exists; discovery never switches the DevSpace
session to whichever historical thread appears newest. A legacy filename-stem ID may be
upgraded only when that exact basename identifies one valid canonical rollout whose payload
proves the canonical ID and workspace-compatible root-thread metadata. Missing or ambiguous
evidence leaves the old private value unchanged and Resume unavailable.

## Isolation

Only the selected harness home is copied into `/opt/devspace/harness-home`. Unrelated homes
are never mounted. After writeback the slot is emptied. Same-container shells may read a
populated slot. Bounded symlink entries are copied as link text without resolving their
targets on the Agent host. Native-session discovery skips symlinked session roots and files,
so container-local absolute links can round-trip without making the host follow them.
Home copies are bounded to 16 directory levels, 16,384 entries, 32 MiB per file, and 256 MiB
total; the entry count includes directories, symlinks, and omitted runtime entries. Codex's
versioned app-server package cache at `packages/app-server-daemon/releases` is ephemeral: it is
walked under the depth and entry limits but omitted during both materialization and writeback,
so large cached binaries do not consume the persistent home-copy budget. Only that exact
release subtree is excluded from the package cache; other package contents follow the rules
below. Codex's exact app-server daemon runtime markers
(`app-server-daemon/{daemon-updater.pid,daemon-updater.pid.lock,daemon-updater.stderr.log,
daemon.lock,daemon.pid.lock,daemon.stderr.log}`) and package installer metadata
(`packages/app-server-daemon/{auto-update-version,current,install.lock}`) are also ephemeral
and omitted in both directions. These volatile PID, lock, log, version-pointer, and release
cache entries are not copied back into the next private home slot. Their exact names are
filtered while traversal still counts every entry; other contents in those directories remain
durable and subject to the normal copy bounds.
Unix sockets in a live slot are ephemeral and omitted during writeback. A Unix socket found in
persistent state is rejected during materialization and is never recreated in a slot. FIFOs,
block devices, character devices, and unknown special objects remain rejected in both
directions. If rootless UID mapping makes a slot-owned directory non-removable by the Agent,
the Agent may use a one-shot cleanup container from the exact configured workspace image. It
receives only the exact private slot mount, has no network, and uses only the
rootless-container-scoped `DAC_OVERRIDE` and `FOWNER` capabilities needed to remove
container-owned directories without following symlinks.
The copy and discovery walkers use path-based checks and do not pin directory handles against
a concurrent same-container writer replacing a checked directory. This rare race is deferred
for the trusted-code beta. Orphan recovery writes a slot back only after its exact owning
workspace container is stopped or proven absent.

## Codex executable

The Agent probes `codex --version` with a structured argv exec inside the exact workspace
container. Image PATH wins (`executableSource.kind = image-path`). If that probe reports
`codex` is absent, DevSpace resolves its Agent-managed Codex artifact, verifies the closure,
and stages it into the workspace container at `/opt/devspace/codex-artifact/<digest>/`.
The native PTY then executes that in-container entrypoint
(`executableSource.kind = agent-artifact`). An Agent-host path is never passed to Docker
exec. The digest directory is a content-addressed in-container cache. An existing closure is
reused only after the pinned helper enumerates its exact tree and every expected file and
symlink is read back and checked for kind, mode, length, SHA-256, or link text. Unexpected
entries invalidate the cache. A stale or partial closure is staged into a unique temporary
directory, verified in full, and then published by rename; entries are never overlaid into an
existing closure. Agent staging attempts for the same container and digest are serialized.
Harness admission replaces a stale cache before admitting the process that will use it. An
ambiguous verification or failed publication fails closed and never authorizes execution; a
failed fresh stage cleans only its own temporary directory and leaves the prior cache intact.
Otherwise start fails with `HARNESS_EXECUTABLE_UNAVAILABLE`. There is no Codex version pin.

Interactive terminal and harness execs receive an initial PTY geometry of 80 columns by 24 rows
at Docker exec creation, before a browser attachment exists. Docker's API represents that initial
size as `[rows, columns]`. After attachment, the browser's measured terminal resize replaces the
fallback; non-TTY task execs do not receive PTY geometry.

A pre-slice development container that has only `/workspace` is upgraded in place. The
existing workspace network, its labels, and the original `workspace.start` operation stay
in place. Only the development container is replaced so it can gain
`/opt/devspace/harness-home`. A failed reconciliation must not adopt a same-name resource
or invent a new creation operation.

## Exit, failure, and restart

Harness PTY exit is observed by ExecutionManager (stream close or an already-finished exec
inspect). That callback settles the matching harness session once: write back the slot,
discover a Codex native id from the persistent home, empty the slot, release the lease, and
mark the Agent-private record stopped. A duplicate or late exit notification is a no-op.
Ordinary `/bin/sh` terminals are not harness executions and do not settle a harness.

If exec creation fails before the process is admitted, the Agent writes the slot back when
needed, empties it, and releases the lease. `TaskStartRecoveryRequiredError` is admission
uncertainty: the lease stays, the private record stays live, and Web leaves the SQLite row
`creating` so the same process id can be retried. A retry of the same process does not launch
a second exec.

Terminal PTY output is retained in the existing bounded 64 KiB replay buffer. When a terminal
exits before a browser attaches, one read-only attachment may receive `ready`, the captured
output, and the exact exit frame during a 30-second window. That attachment cannot send input or
resize, does not restart the process, and consumes the replay. The buffer is cleared on delivery
or expiry. This also lets ordinary terminals display diagnostics from short-lived commands.

Startup also reconciles a harness exec with a durable exit observation when its exact private
session still records pending settlement. This closes the crash window between recording the
exec exit and completing its settlement callback. The private session record persists a
ready-to-release checkpoint before removing the lease, so a restart can finish release without
re-copying an already-cleared slot or removing a newer lease.

Agent restart loses the PTY and terminal attachment. Harness execution identity is durable. For
an older record without that role, startup may classify it as a harness only by correlating one
exact private harness session, process, workspace, generation, lease, and dirty slot. Ambiguous
or incomplete evidence does not authorize recovery.

Before touching a dirty slot, startup inspects the exact retained Docker exec in its exact
owning workspace container. If it is still running, the process observation remains `running`
while the terminal attachment and private harness session become `lost`. The slot and lease
remain intact, no native-id discovery runs, and Resume is unavailable. The Agent monitors that
exact exec. If its state is unproven, the slot and lease also remain intact and Resume stays
unavailable.

Only an observed exit code, or proof that the exact owning workspace container is stopped,
absent, or replaced after the old container is confirmed gone, authorizes recovered finalization:
write back the dirty slot, discover a native id, empty the slot, and release the lease. The
session remains `lost` because its PTY was lost. Resume becomes available only after finalization
has released the lease and only when the harness has a resumable native session (or the
definition supports provider-handled resume). Stopping the workspace runtime is the supported
way to retire an orphan that remains running; individual process stop remains unsupported.

Web applies the existing Agent snapshot: a closed or failed harness terminal becomes SQLite
`stopped`; a lost harness terminal becomes SQLite `lost`. Resume is projected from the Agent's
recovery-aware capability. No extra poll is added.

## Resume generation and custom definitions

Start uses process generation 1. Each resume claims the next SQLite generation atomically.
The same number is sent to the Agent, stored on the private record, and recorded on the home
lease. A stale or concurrent generation is rejected. A definite pre-start resume failure rolls
the SQLite generation back; an uncertain admission or a lost response does not.

Web owns custom definitions in SQLite and sends the validated definition on start and resume.
The Agent pins a digest of launch, resume, and environment. A missing definition or a digest
mismatch fails closed. The browser still cannot submit argv, env, native ids, or host paths.

The Workbench Resume control follows the boolean `resume` projected from Agent capability.
That boolean is true for provider-handled custom resume without a native id, and false for
Codex or id-based custom resume until a real native id exists. Native ids are not returned.

## Routes outside the frozen inventory

`POST /v1/harness-sessions/start`, `/resume`, and `/inspect` are synchronous harness
admissions. They are intentionally outside the frozen F10/F11 operation inventory: expanding
that schema is not required for the slice, and these calls are not journaled workspace
mutations. They still fence authority and retries:

- Web creates at most one `creating` native session and reuses it, including its terminal, on
  retry.
- The Agent returns success without a second exec when that same process is already live.
- A definite Agent rejection fails the `creating` row or rolls a resume claim back.
- A timeout or `HARNESS_ADMISSION_UNCERTAIN` leaves `creating` so the client retries the same
  process instead of starting another harness.

## Structured Codex

F11, app-server, turn cards, and the outbox remain the structured path. This contract does
not retire them.
