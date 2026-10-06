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

The Native Workbench is the default presentation. The structured Codex app-server path remains
available as the secondary Legacy presentation; retirement of that path is a separate future
decision.

## Consequences

- Native harness sessions use the `native-pty` runtime kind. Native is the default Workbench
  presentation; the structured Codex app-server path remains available under Legacy.
- Persistent harness homes are Agent-owned, exclusively leased, and never stored in `/workspace`.
- A populated slot is visible to other processes in the same trusted container.
- The Workbench default switch is complete. Structured-path retirement has not happened.
- Harness PTY exit settles through ExecutionManager. Agent restart and that exit are projected
  onto SQLite as `lost` and `stopped`. Resume generation is monotonic. Custom resume carries
  the Web-owned definition and a pinned digest. Codex executable detection is an image PATH
  probe with an Agent-artifact fallback.
- Built-in Codex launch and resume use `--yolo --no-daemon`, binding provider writes to the
  lifetime of the foreground harness generation. The Codex native thread identity is taken
  from the canonical rollout `session_meta` record's `payload.id` and remains bound to one
  DevSpace session across generations.
- Codex artifact staging uses a verified content-addressed in-container cache. Private-home
  writeback omits Unix sockets and bounded ephemeral daemon state; those objects are never
  materialized from persistent state. The exact bounded app-server package cache is ephemeral.
- Interactive PTYs start at 80x24 and accept browser resize updates. Fast-exit terminal output
  is retained in a bounded 64 KiB replay buffer for one read-only claim within 30 seconds;
  Web permits a closed-terminal upgrade only during that window, and the Agent remains the
  authority for the replay claim.
- A running orphan keeps its dirty slot and exclusive lease until its exact exec exits or its
  owning workspace container stops. Workspace Stop recovery finalizes the slot before Resume
  becomes available. Workbench selection is bound to the selected DevSpace session ID across
  projection refreshes.

## Live acceptance

Live acceptance completed on 2026-10-06. The authenticated native Codex TUI used a private
`CODEX_HOME` and completed exactly one real model request, receiving
`DEVSPACE_NATIVE_HARNESS_OK`. The same persisted conversation was restored through native Resume
across multiple generations, including after deliberate Agent loss and workspace Stop recovery.
Clean foreground exit with `--no-daemon` left the slot empty and quiescent after settlement.

The live run also verified bounded post-exit replay through the Web terminal WebSocket: a harmless
custom harness rendered `DEVSPACE_CUSTOM_HARNESS_OK` and `CODEX_HOME=unset`, delivered exit code 0,
and rejected a second output claim. The custom harness used no Codex home lease or provider.
