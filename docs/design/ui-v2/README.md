# UI v2 design reference

Reference screens for the UI v2 redesign. The implementation plan is
[`docs/specs/ui-v2.md`](../../specs/ui-v2.md).

## How to use these files

- `screens/*.png` show the target look. Use them for layout, hierarchy and density.
- `html/*.html` are the same screens as static HTML with inline styles. Open them for exact
  spacing, sizes and colours. They are mockups, not components: do not copy their markup into
  `apps/web`. Build real components from `tokens.css` instead.
- `tokens.css` holds every colour, size and radius the screens use. Slice 1 moves it into
  `apps/web/src/ui/tokens.css`.
- `fonts/` holds Geist and Geist Mono (SIL Open Font License, see `OFL.txt`). The app should
  load them from the `geist` npm package, not from Google Fonts.

## Rules when the mockup and the code disagree

1. Contracts and domain state win. The data in the screens is illustrative. If a screen shows
   a field, state or action the contracts don't have, implement what the contracts support and
   note the gap in the PR.
2. The state vocabulary (`10-state-vocabulary`) is normative. Every lifecycle state in
   `packages/domain` maps to exactly one of its nine glyphs.
3. Layout and hierarchy are normative; pixel values are guidance. Within a few pixels is fine.
4. Accessibility beats the mockup: real buttons and links, labels on icon-only buttons,
   visible focus, 4.5:1 text contrast.

## Screens

| File | Screen | Notes |
| --- | --- | --- |
| `01-inbox` | Inbox | Needs you, Ready to review, Problems. Top approval expands in place. |
| `02-session-chat` | Session, Chat view | Structured providers only (Codex app-server). Approval docks above the composer. |
| `03-session-terminal` | Session, Terminal view | Any CLI agent in its real terminal. Side panel shows changes since the last prompt. |
| `04-changes-expanded` | Changes panel expanded | Replaces the old Review preset. Diff comments queue as the agent's next prompt. |
| `05-files-expanded` | Files panel expanded | Replaces the old Code preset. Editor beside the session terminal. |
| `06-workspace` | Workspace | One banner for the actual problem, then agents, tasks, previews, terminals. |
| `07-project-options` | Project Options | Apply panel shows the runtime-plan diff before applying. |
| `08-new-session` | New session | Pick an agent, pick Terminal or Chat, add a custom CLI. |
| `09-command-palette` | Ctrl K | Sessions, actions, files. |
| `10-state-vocabulary` | State glyphs | Normative mapping from lifecycle states to glyphs. |
| `11-mobile-inbox` | Mobile inbox | |
| `12-mobile-approval` | Mobile approval | |
| `13-mobile-terminal` | Mobile terminal session | Key bar plus approval card from the hook relay. |

Shared pieces: the sidebar (260 px, sessions grouped by status) appears on 01–03; the collapsed
rail (56 px) appears on 04–07.
