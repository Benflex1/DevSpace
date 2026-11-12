# Native Codex history after refresh (2026-11-12)

## Findings

The Bankroll dogfood report is the real-provider evidence: after using Native Codex and navigating
up through history, the visible text becomes a short portion of the conversation mixed with status
and usage rows, numbers, blank lines, and fragments such as `026l`. PR #86's `--no-alt-screen`
change does not meet readable-history acceptance.

There are four different things in this path:

1. **Codex rendering.** The CLI is a full-screen terminal UI. `--no-alt-screen` selects the primary
   screen, but Codex still uses cursor movement and redraws for status, usage and conversation
   updates. Primary-screen output is not a semantic transcript.
2. **Tmux pane history.** Tmux stores lines that scroll off the pane. Copy mode exposes this
   line-oriented terminal history; it cannot distinguish a user-visible final answer from TUI
   redraws or status output. Increasing `history-limit` only retains more of the same stream.
3. **Xterm scrollback.** The Web terminal resets xterm on every attachment and receives the new
   tmux client's redraw/live byte stream. Xterm interprets terminal control sequences; its
   browser-local scrollback is not the persistent history store and is intentionally not restored.
4. **Codex conversation history.** Codex persists structured rollout records in its private
   `CODEX_HOME`. The canonical `session_meta.payload.id` is already bound to the DevSpace Native
   session. This provider-owned data is the appropriate source for readable earlier messages.

The Bankroll report plus the implementation path implicate terminal/TUI output as the source of
the misleading lines. A paired capture of `tmux capture-pane` for the exact Native pane and the
browser-rendered frame was not available in this isolated worktree, so it remains the final check
for whether any additional browser serialization defect contributes. Do not treat the current
History button, ordinary scrollback, or `--no-alt-screen` as conversation-history recovery.

## Proposed implementation

Add a **Codex-specific, read-only history projection** beside the Native session view. Do not add a
provider-neutral transcript parser: the Native process lifecycle remains provider-neutral, while
the Codex adapter understands only Codex-owned rollout records.

- Web authorizes the authenticated actor against the exact project, workspace, DevSpace Native
  session and Codex provider. The browser sends the DevSpace session ID, never a path or native
  thread ID. The Agent resolves the already-bound native ID from its own session record.
- The Agent opens only that thread's canonical rollout beneath the dedicated Codex home, verifies
  its owner/private-file invariants and canonical `session_meta.payload.id`, and reads a bounded
  snapshot. Reject symlinks, ambiguous matches, foreign/missing IDs, malformed records, or an
  unsettled private-home lease where a consistent read cannot be proven.
- Project a capped page of completed `user` and final `assistant` message text with timestamps.
  Exclude system/developer instructions, analysis, tool calls/results, environment/configuration,
  usage/status events, local paths, and all other rollout fields. Apply the existing secret
  redaction policy. Do not return raw JSONL, auth material, or the rollout path.
- Bound both input bytes scanned and projected output bytes/messages. Use a session-bound opaque
  cursor for older pages; reject cursors for another actor/session/thread. Return explicit
  truncation and unsupported-record notices rather than silently claiming a complete transcript.
- Keep this view read-only and separate from the live terminal. It must not submit turns, resume
  Codex, write rollout data, or change Native session state. Do not store projected transcript
  text in browser storage or SQLite.

OpenAI's Codex source tests show the rollout JSONL shape and canonical session metadata fields
([Codex rollout fixtures](https://github.com/openai/codex/blob/main/codex-rs/app-server/tests/common/rollout.rs)).
The exact extraction contract still needs to be pinned against the bundled Codex version and its
typed protocol definitions before implementation; rollout format changes must fail closed. T3 Code
was inspected as required. Its documented history import and bounded handoff behavior support
provider-owned structured history as the correct class of solution, while DevSpace should retain
its own Agent/Web authority boundaries ([T3 Code thread migration](https://github.com/pingdotgg/t3code/blob/main/docs/user/thread-migration.md),
[portable handoffs](https://github.com/pingdotgg/t3code/blob/main/docs/user/portable-handoffs.md)).

## Acceptance still required

1. In an isolated authenticated Codex home, produce at least three distinct real user/assistant
   exchanges, including a long response and a usage/status refresh.
2. Record exact pane history with fixed `capture-pane` and the matching browser output after
   History navigation and after F5. This identifies whether the terminal artifacts are already in
   tmux's retained lines and verifies xterm is not adding them.
3. With the proposed projection, verify all earlier real user prompts and completed assistant
   answers are readable after F5, with correct order and paging; no status rows, tool output,
   credentials, unrelated thread data, or unsaved editor content appear.
4. Verify wrong project/workspace/session, stale thread, malformed rollout, oversized page and
   expired cursor are denied or bounded. Confirm Native PID/thread continuity remains unchanged.
5. Test project/workspace switching and reload in the real authenticated browser. Until that passes,
   conversation-history recovery is not fixed.
