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
populated slot.

## Codex executable

The Agent probes `codex --version` with a structured argv exec inside the exact workspace
container. Image PATH wins (`executableSource.kind = image-path`). The Agent-managed artifact
is used only when that probe reports `codex` is absent and `DEVSPACE_CODEX_EXECUTABLE_PATH`
is configured. Otherwise start fails with `HARNESS_EXECUTABLE_UNAVAILABLE`. There is no
Codex version pin.

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

Agent restart loses the PTY. The Agent recovers a dirty slot, discovers the native id, marks
its private record `lost`, and releases the lease. Web applies the existing Agent snapshot:
a closed or failed harness terminal becomes SQLite `stopped`; a lost harness terminal becomes
SQLite `lost`. No extra poll is added.

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
