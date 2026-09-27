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

## Isolation

Only the selected harness home is copied into `/opt/devspace/harness-home`. Unrelated homes
are never mounted. After writeback the slot is emptied. Same-container shells may read a
populated slot. Bounded symlink entries are copied as link text without resolving their
targets on the Agent host. Native-session discovery skips symlinked session roots and files,
so container-local absolute links can round-trip without making the host follow them.
Home copies are bounded to 16 directory levels, 16,384 entries, 32 MiB per file, and 256 MiB
total; the entry count includes directories and symlinks.
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
exec. Otherwise start fails with `HARNESS_EXECUTABLE_UNAVAILABLE`. There is no Codex version pin.

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
