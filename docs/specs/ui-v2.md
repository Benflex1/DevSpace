# UI v2: redesigned Workbench

- Status: Proposed
- Date: 2026-10-25
- Baseline: `main` @ `10a950d`
- Design reference: [`docs/design/ui-v2/`](../design/ui-v2/README.md)

## Goal

Replace the current Workbench UI with the v2 design: a session-centred app where the sidebar
groups every agent session across projects by what it needs from the owner, each session can
be viewed as a structured chat or as the agent's real terminal, and evidence (changes, files,
preview, shell) sits in one side panel. The same state drives a mobile layout so approvals can
be answered from a phone.

The redesign keeps every existing boundary: the browser talks only to Web, Web is the only
SQLite writer, the Agent owns Docker, Git, filesystem, PTYs and providers.

## Decisions

1. **Chat view only for structured providers.** ADR 016 forbids faking provider conversation
   UI. Chat is available for providers with a real structured protocol (today: Codex
   app-server). CLI-only agents show the Chat | Terminal toggle with Chat unavailable and a
   one-line reason. *Owner to confirm before slice 3.*
2. **The structured path becomes Chat, not Legacy.** The existing Native | Legacy switch in
   `ai-workbench-tab.tsx` becomes Terminal | Chat. Slice 3 adds an ADR 016 amendment recording
   that the structured path is kept, not retired.
3. **Presets are panel states.** The old Agent/Review/Code presets are replaced by one side
   panel (Changes, Files, Preview, Shell) that can expand to full width.
4. **New shell behind a flag.** v2 renders behind a per-user `ui=v2` setting until slice 5, then
   becomes default; v1 is deleted in the PR after that.
5. **Hooks never replace the native CLI experience.** While a browser is attached to a harness
   pane, the agent's own prompts appear in its terminal; DevSpace only marks the session as
   needing attention. Remote answering applies only when nobody is attached.
6. **No guessing.** "Needs you" for a CLI agent comes only from a real signal (hook event).
   Never pattern-match terminal output.

## New backend pieces

| Piece | Owner | Purpose |
| --- | --- | --- |
| Attention feed | Web | Derives inbox and sidebar items from SQLite; snapshot route plus NDJSON stream |
| Web Push | Web | Notifies when an item enters Needs you; payload carries an item ID only |
| Hook relay | Agent | Receives hook events from CLI agents through a long-lived `docker exec` |
| `devspace-hook` | Container | Small helper the CLI's hook config calls; forwards to a container-local Unix socket |
| Turn snapshots | Agent | Records the worktree as a Git commit at turn boundaries for per-turn diffs |

Each needs contract types in `packages/contracts` before implementation. The hook relay needs
its own ADR (new transport into the container) before slice 7.

## Slices

One slice per PR. Each leaves `main` shippable and keeps the Playwright suite green.

| # | Slice | Scope | Depends on | Acceptance |
| --- | --- | --- | --- | --- |
| 0 | Clear the deck | Merge AI CP2 after real-browser dogfood; fix #77–#81; update `docs/current-state.md` (Slice 1 terminals is merged) | — | CP2 on `main`; issues closed |
| 1 | Tokens and primitives | `apps/web/src/ui/`: `tokens.css`, Button, IconButton, Segmented, StatusGlyph; Geist via `geist` package | 0 | StatusGlyph switch is exhaustive over every `*States` array in `packages/domain` (typecheck fails on a new unmapped state); a dev-only route renders all glyphs |
| 2 | App shell (v2 flag) | Split `project-workbench.tsx` into Sidebar, Main, SidePanel, StatusBar; mount existing tab components inside | 1 | Playwright passes with v1 and v2 |
| 3 | Session view | Terminal \| Chat per session; thread styling (collapsed activity, changed-files card, approval dock above composer); session titles from first prompt | 2 | Approve a real Codex command from the dock; ADR 016 amendment merged |
| 4 | Side panel | Changes, Files, Preview, Shell icon tabs; expand to full width | 2 | Stage, commit and push from expanded Changes |
| 5 | Attention feed | `deriveAttention`, `attention_acks` table, `/api/attention` + stream, sidebar status groups, Inbox page; v2 becomes default | 3, 4 | A pending approval in project A appears in the sidebar while project B is open, within 2 s |
| 6 | Harness on tmux | ADR 017 Slices 2 and 3 for Native harnesses | 0 | A Claude Code session survives Agent restart and browser reload with screen intact |
| 7 | Hook relay | ADR; `devspace-hook`; Agent relay; Claude Code adapter (`PermissionRequest`, `Notification`, `UserPromptSubmit`, `Stop`) configured in the private home | 5, 6 | A Claude Code permission request appears in the Inbox and is approved there with no browser attached to the pane |
| 8 | Turn snapshots | Agent snapshot operation; `snapshot` diff kind; This turn / Session scopes; diff comments queue as prompts | 4 | Scope selector shows exactly the files one turn changed |
| 9 | Palette and settings pages | Ctrl K; Project Options runtime-plan diff; Workspace page; New session sheet with custom-harness editor | 2 | A custom CLI added in the sheet launches in Terminal view |
| 10 | Mobile | Responsive shell below 760 px; approval and terminal screens; key bar; PWA manifest; Web Push | 5, 7 | Approve from a phone notification with no desktop browser open |

Slices 6 and 8 have no visual dependency and can run in parallel with 1–5.

## Implementation notes

**Attention feed.** `deriveAttention(db): AttentionItem[]` is a pure function, unit-tested with
fixtures. Sources: pending `ai_interaction_requests`, sessions in waiting states, completed
turns not yet acknowledged, failed `task_runs`, unhealthy previews, lost terminals, draft
config revisions; harness sessions once hooks exist. Items have stable keys
(`interaction:<id>`). Write paths call an in-process `attentionBus.notify(projectId)`; the
stream recomputes and sends upserts and removals, with a 10 s reconcile tick as a safety net.
Reconnect sends a fresh snapshot (no replay log). Reuse auth and abort handling from
`api/projects/[projectId]/ai/events/route.ts`.

**Turn snapshots.** Host-side, in the managed worktree, with a temporary index:

```bash
export GIT_INDEX_FILE=$(mktemp)
git add -A
tree=$(git write-tree)
commit=$(git commit-tree "$tree" -m "devspace snapshot")
git update-ref "refs/devspace/snapshots/<session>/<n>" "$commit"
```

Snapshot at `turn.started` and `turn.quiesced` (Codex), at `UserPromptSubmit` and `Stop` hooks
(Claude Code), and at session start plus a manual Checkpoint action (other CLIs). Store commit
IDs on `ai_turns`. Cap snapshots per session; delete refs with the session.

**Hook relay.** Claude Code reference: <https://code.claude.com/docs/en/hooks>.
`PermissionRequest` answers with `hookSpecificOutput.decision.behavior` = `allow` | `deny`.
When tmux reports an attached client, the hook returns no decision at once so the native
dialog shows; otherwise it blocks until answered in DevSpace or a timeout, then falls back to
the native dialog. Hook config lives in the Agent-owned private home (`CLAUDE_CONFIG_DIR`),
never in the repository. Codex `notify` provides turn completion only; other CLIs get
Working/Idle from tmux pane activity.

**Session titles.** `ai_sessions.title` exists. Set it from the first prompt's first line,
trimmed to about 60 characters; Claude Code via `UserPromptSubmit`; editable otherwise.

**Plan diff.** Compile draft and active revisions with `packages/project-options`, diff the
canonical runtime plans, map changed paths to sentences. Pure function.

**Palette files.** New Agent operation returning `git ls-files -co --exclude-standard`,
capped and cached per `HEAD`; fuzzy match client-side.

## Spikes to run before the dependent slice

- [ ] `PermissionRequest` hook exiting 0 with no output leaves Claude Code's own dialog in place (slice 7)
- [ ] Claude Code reads hook config from `CLAUDE_CONFIG_DIR` (slice 7)
- [ ] tmux attached-client count and pane silence can be polled cheaply (slices 6, 7)
- [ ] `git add -A` + `write-tree` stays under about 300 ms on a large repo (slice 8)
- [ ] A Codex app-server thread resumes in the Codex CLI with history; if not, switching view starts a new session (slice 3)
- [ ] Web Push reaches an installed PWA behind Cloudflare Access on Android and iOS (slice 10)

Record each result in this file before starting the slice it gates.

## Out of scope

Multiple isolated workspaces (Milestone 4), checkpoint rollback, hostile-process containment,
a native mobile app. "Create a project from scratch" and task output UX remain separate beta
gates and continue in parallel.
