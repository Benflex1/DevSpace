# ADR 016: Generic native AI harnesses

- Status: Accepted as product target
- Date: 2026-09-20
- Supersedes as product target: ADR 015
- Preserves: ADR 015 remains accepted for the shipped structured Codex app-server path until a later retirement stage

## Context

DevSpace must host arbitrary terminal-based AI coding harnesses. The structured Codex
JSONL app-server path cannot express Claude Code, Gemini CLI, OpenCode, or a custom TUI
without inventing a second conversation protocol.

## Decision

The product architecture is:

```text
Browser → Web → Agent → exact workspace container → Docker exec PTY → real native harness CLI
```

Built-in providers are presets over one generic mechanism (structured argv, optional resume
template, optional private home). Custom harnesses use the same mechanism. DevSpace does
not fake provider conversation UI or native session IDs.

The structured Codex Workbench remains shipped and default until a later migration stage.

## Consequences

- Native harness sessions are a parallel runtime kind (`native-pty`) beside structured sessions.
- Persistent harness homes are Agent-owned, exclusively leased, and never stored in `/workspace`.
- A populated slot is visible to other processes in the same trusted container.
- Stage 3/4 migration (default switch and structured-path retirement) has not happened.
- Harness PTY exit settles through ExecutionManager. Agent restart and that exit are projected
  onto SQLite as `lost` and `stopped`. Resume generation is monotonic. Custom resume carries
  the Web-owned definition and a pinned digest. Codex executable detection is an image PATH
  probe with an Agent-artifact fallback. Live Codex acceptance is still outstanding.
