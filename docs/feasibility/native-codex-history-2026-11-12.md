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

## Implemented bounded history view

The review branch integrates **Codex conversation history into the single Native AI surface**.
Semantic saved messages sit above the live terminal in one shared scroller: scrolling up reveals
them, scrolling down returns to the live terminal, and the terminal stays mounted and attached.
The persistent Native execution and lease lifecycle remains provider-neutral; only the adapter
understands Codex rollout records. A header action jumps between the live terminal and history for
keyboard users; it is not a separate history tab. The tmux control remains labeled **Pane
scrollback** to distinguish TUI output from conversation text.

### Ownership and source selection

- The authenticated Web route derives actor identity from authentication and accepts only the
  project ID, workspace ID, Native DevSpace session ID, and signed paging cursor. It rejects
  browser-supplied filesystem paths and native thread IDs. The database requires the exact
  primary project/workspace and a `native-pty` Codex session, then derives process ID and generation
  from that row before calling the Agent. A legacy row created before process persistence has no
  database process identity; the read proves a matching identity from the exact Agent private
  session record and never persists an invented process row.
- The Agent reads the private Native session record without invoking lifecycle repair or saving
  changes. It checks the exact harness, workspace, DevSpace session, process ID, generation,
  admission, recovery state, and lease source. When the live native thread ID is still null, the
  record's pre-launch discovery baseline must exist; a missing baseline fails closed.
- For a live session, `HarnessHomeStore` verifies the exact Codex lease, workspace, DevSpace
  session, generation, dirty slot metadata, and non-symlink leased slot. Discovery selects exactly
  one new root rollout whose canonical ID is `session_meta.payload.id`, `cwd` is `/workspace`, and
  `parent_thread_id` is null. Duplicate IDs, multiple new root rollouts, foreign cwd, malformed
  metadata, and symlinked files cannot be selected.
- For a settled session, the Agent requires the canonical native ID already bound to its private
  session record, no active private-home lease, a clean exact workspace slot marker, and no other
  dirty Codex slot before opening the persistent home. A live cursor cannot be reused after source
  settlement or resume.

### Snapshot, projection, and limits

- The rollout is opened read-only with no-follow semantics. The selected source must be a regular,
  single-link file no larger than 32 MiB. Metadata discovery scans at most 4,096 rollout files,
  16,384 directory entries, and 16 MiB of first-line metadata. A history read considers at most
  the final 4 MiB of JSONL, rejects records above 1 MiB, caps the projection at 8,192 records and
  2,048 messages, and returns 20 messages per page. A single projected message above 32 KiB fails
  closed instead of being silently truncated.
- For active writes, the Agent captures a fixed file-size snapshot, reads from an open descriptor,
  drops incomplete boundary lines, verifies the metadata and bounded snapshot bytes with a second
  read, and rechecks file identity. Append-only growth beyond the captured size does not alter that
  page. In-place changes, truncation, replacement, hard links, and symlinks fail closed. Reads do
  not write the home, slot, lease, or private session record.
- The supported Codex allowlist is explicit. Legacy `event_msg/user_message.message` records
  provide user text. Newer `response_item/message` records provide only `input_text` for user
  messages and `output_text` for assistant messages in `final_answer` phase. Assistant text is
  released only at a matching successful `task_complete`/`turn_complete`, with
  `last_agent_message` preferred and the typed final response item as fallback. Commentary,
  reasoning, developer/system messages, tool calls/results, metadata, token usage, status events,
  and raw response fields are ignored. Unknown top-level or event record types fail closed.
- Output text passes the existing secret redactor plus provider-token, JWT, private-key, credential
  URL, absolute and relative path, and terminal-control scrubbing. The browser renders only role, timestamp, and
  plain message text. API responses are `no-store`; transcript text is held only in component
  memory. The signed cursor binds the actor digest, project, workspace, DevSpace session,
  process generation, source, snapshot size/digest, and page offset. It contains no native thread ID
  or host path and expires with the Agent process's in-memory HMAC key.

Codex's primary source documents the v1 aliases `task_started` / `task_complete` for turn events,
and the official rollout tests include `event_msg` and typed `response_item` fixture shapes
([Codex protocol](https://github.com/openai/codex/blob/main/codex-rs/docs/protocol_v1.md),
[rollout tests](https://github.com/openai/codex/blob/main/codex-rs/rollout/src/tests.rs),
[protocol message items](https://github.com/openai/codex/blob/main/codex-rs/protocol/src/items.rs)).
The implementation pins the supported projection subset through synthetic compatibility fixtures;
the configured real Codex CLI version still needs authenticated acceptance. Rollout changes remain
fail-closed until their safe user-visible schema is explicitly supported. T3 Code was inspected as
required; its documented history import and bounded handoff behavior support using provider-owned
structured history while retaining DevSpace's Agent/Web authority boundaries
([T3 Code thread migration](https://github.com/pingdotgg/t3code/blob/main/docs/user/thread-migration.md),
[portable handoffs](https://github.com/pingdotgg/t3code/blob/main/docs/user/portable-handoffs.md)).

## Dogfood failure diagnosis

Two dogfood failures came from durable state, not a reset-worthy condition:

1. **New Native Start rejected.** The previous Native session still had its private-home lease,
   dirty slot metadata, and `recoveryPending: true`. Its Docker exec returned 404 because the
   workspace container had started after that exec was created; the old recovery classifier saw a
   running container and reported `unproven`, so the loss never settled. Admission then found a
   leased/`recoveryPending` record for the workspace and rejected every new Start as already live.
   The Agent now treats an exec that is missing from the current lifetime of the exact container as
   definitely gone, but keeps a same-lifetime daemon restart unproven. Definite admission failures
   also close their prepared terminal/process rows.
2. **Legacy history unreadable.** The old Native database row had no terminal/process identity
   because it predates session persistence. The history route failed closed with
   "The Codex history session is unavailable." The read now obtains the exact process identity from
   the Agent's private session record without mutating SQLite.

These fixes do not reset sessions, delete leases, or stop containers. After deploying the fixed
Agent and restarting it, the stale record must settle from the container-start evidence and release
its lease before real acceptance proceeds.

## Acceptance still required

1. In an isolated authenticated Codex home, produce at least three distinct real user/assistant
   exchanges, including a long response and a usage/status refresh.
2. Record exact pane history with fixed `capture-pane` and the matching browser output after
   Pane scrollback navigation and after F5. This identifies whether the terminal artifacts are
   already in tmux's retained lines and verifies xterm is not adding them.
3. Verify scrolling up in the single AI surface shows all earlier real user prompts and completed
   assistant answers after F5, in order and through older-page navigation, with no status rows,
   tool output, credentials, unrelated thread data, or unsaved editor content; scrolling down
   returns to the still-attached live terminal without losing keyboard input, selection, or scroll
   position.
4. While that authenticated session is active, confirm the same Codex PID and DevSpace session
   remain live after reading. Close and resume Codex, then verify the same history remains readable
   from the resumed live slot and after settlement.
5. Verify wrong project/workspace/session, stale thread, malformed rollout, ambiguous source,
   oversized message, changed snapshot, and expired cursor fail closed. Until this real-provider run
   passes, conversation-history recovery is not fixed.
