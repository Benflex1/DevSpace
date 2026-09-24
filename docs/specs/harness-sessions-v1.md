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

Prefer workspace-image `codex` on PATH. Agent-managed artifact is fallback only. Record
`executableSource.kind`.

## Structured Codex

F11, app-server, turn cards, and the outbox remain the structured path. This contract does
not retire them.
