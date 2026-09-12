# AI Workbench / AI Session Beta Checkpoint 2

## Status

Approved design for implementation on `feat/ai-workbench-checkpoint-2`, based on
`47bf2d8c70dcab7b2ff278eb241e927db02a6dd0`. Amendments cover profile-revision lifecycle,
capability authority, atomic interaction retirement, ambiguous response reconciliation, and
staged/unstaged changed-file selection.

## Goal

Complete the owner-only browser Codex workflow in the existing DevSpace Workbench:
persisted AI sessions can be selected, turns can pause for bounded command/file approvals
or structured questions, browser responses continue the same provider turn, and AI changed
files open through the existing Workbench editor/Changes authority.

## Existing boundaries to preserve

- The browser calls only the Web application. Web remains the sole SQLite writer.
- The Web application never invokes Git, shell commands, Docker, or Caddy.
- The Agent owns the dedicated rootless provider/runtime process and all provider-private
  state.
- Browser actions contain only route-bound DevSpace identifiers and bounded decisions/answers.
- The browser never supplies profile revisions, process generations, provider executable
  details, provider-native request IDs, arbitrary command text, or host paths.
- Provider responses remain bounded stdio/PTY operations inside the Agent-owned session.
- No auto-merge, deployment, provider marketplace, session management suite, or runtime
  architecture redesign is part of this slice.

## Provider-private interaction identity

Codex JSON-RPC request IDs remain private to the Agent/provider authority layer. When the
Agent receives a supported Codex server request, it creates a DevSpace-owned durable
interaction request ID and binds the native request ID to it only in the active provider
process. The DevSpace ID is the only identity used in:

- `turn.approval.requested` and `turn.input.requested` canonical events;
- Web persistence in `ai_interaction_requests`;
- browser projection and response actions;
- Agent operation requests from Web.

The binding is removed when the provider request is resolved or the provider session is
lost. A provider-native ID is never copied into the public presentation or Web response.

## Provider/session behavior

The managed Codex process is started with the existing per-session authority and the
session-scoped `on-request` approval policy. This changes the authority tuple/profile
revision for the managed Codex session only; it does not modify ambient host configuration.
The Agent advertises `approvals` and `structuredInput` only for this supported Codex
process path.

Existing sessions remain pinned to the profile revision stored when they were created. A
stopped or lost session whose stored revision differs from the current authoritative Codex
profile is historical-only: it remains selectable for inspection but is not restarted under
the new revision. Creating a new session is allowed when no current nonterminal/live Codex
session exists, and historical stopped/lost sessions do not block that creation. Repeated or
ambiguous create requests reuse the existing current nonterminal session through the current
database/session-lease idempotency behavior instead of creating another live session. The
one-live-Codex/provider lease remains authoritative.

The Agent validates the pinned Codex v0.145 request shapes before projecting them:

- command approval becomes a redacted command presentation with safe summary, command text,
  relative working directory, and risk classification;
- file-change approval becomes a bounded redacted path presentation, using only paths the
  Agent can safely canonicalize;
- tool user input becomes bounded provider-neutral questions. Secret questions are rejected
  safely because the DevSpace beta contract does not support secret input.

The provider-native response mapping (`approve`, `acceptForSession`, `decline`, `cancel`,
and provider-native input answer encoding) is performed only in the Agent adapter.

## Durable Web interaction projection

The existing `ai_interaction_requests` table is the durable projection. Canonical requested
events insert pending rows; canonical responded events transition the matching row to its
resolved state and persist the bounded public response. Both the canonical event append and
its interaction projection occur atomically in the same Web database transaction. Duplicate
canonical events are idempotent. A request or response for a different session, turn, kind,
or already-resolved row is rejected or ignored according to the existing canonical event
conflict rules.

When a turn or session becomes terminal, the same durable projection retires its still-pending
interactions using the existing lifecycle state that matches the cause: `lost` for provider or
session loss, `cancelled` for explicit cancellation/interrupt, and `expired` where the
existing lifecycle semantics identify an expiry. No pending row belonging to a lost or
terminal turn remains actionable after refresh or replay. Retired and resolved rows remain
visible as non-actionable history, and duplicate request/response/retirement processing is
idempotent.

The selected-session inspection response returns these interactions, including an explicit
history-truncated indication when the bounded response omitted older rows. The server does
not derive actionable UI solely from transient React state.

## Exact response authority

The two response actions remain in `POST /api/projects/[projectId]/ai` and use strict
action-specific parsing. Before each Agent call, Web obtains the current authoritative Agent
provider profile and requires its profile ID/revision to match the persisted session binding.
It also requires the relevant current capability (`approvals` or `structuredInput`) to be
enabled; capability flags are not duplicated into SQLite. Web then resolves the persisted
session through the route project and workspace and verifies:

1. project ID;
2. workspace ID;
3. session ID;
4. turn ID;
5. DevSpace request ID;
6. interaction kind;
7. pending interaction state;
8. interaction type and current profile capability.

Web derives profile revision, process generation, and provider/session authority from the
persisted session. It creates the Agent operation ID and sends only the bounded decision or
validated answer set. Existing `AI_SESSION_STATE_CONFLICT`, `AI_TURN_STATE_CONFLICT`, and
`AI_INTERACTION_STATE_CONFLICT` semantics are reused for stale, wrong-binding, duplicate,
or wrong-type requests.

The Agent resolves the DevSpace ID to the private provider binding, verifies its own active
session/turn/process authority, and responds to the exact provider request. It rejects
duplicate response claims and mismatched interaction kinds without retrying the provider
request.

## Canonical reconciliation

The canonical responded event is authoritative. A successful Agent mutation is reconciled
through the existing event stream/replay path before Web reports a completed response when
possible. If Web/Agent transport becomes ambiguous after the provider may have received the
response, Web reloads or replays canonical events and checks durable interaction state. The
absence of a responded event is never treated as proof that the provider did not receive the
response:

- a matching responded event completes the interaction;
- reconciliation requires a positive synchronization boundary under the same process
  generation;
- before a pending interaction can become actionable again, the Agent must positively prove
  that it still owns the exact pending DevSpace-request-ID to provider-request binding;
- if the provider binding is gone or the outcome remains unprovable, the interaction remains
  reconciliation-required and non-actionable.

The server never resends the same provider response merely because a transport result is
uncertain. Tests prove that an ambiguous transport cannot answer one provider request twice.

## Browser projection and UX

The browser uses one deterministic interaction reducer for persisted inspection data,
canonical replay, and live events. It upserts by DevSpace request ID, applies request before
response regardless of arrival order, and does not duplicate cards. A response event retires
the input controls exactly once.

The AI Workbench adds:

- a compact persisted-session navigator showing the selected session and coarse state;
- create/select behavior bounded by the existing one-live-Codex/provider lease;
- inline command approval cards with summary, redacted command, working directory, risk, and
  exactly the four contract decisions;
- inline file-change approval cards with bounded paths and truncation notice;
- inline multi-question structured-input cards with single-select or text answers and complete
  answer validation;
- compact resolved interaction presentations;
- reconnect/degraded and interaction-history truncation notices without hiding uncertainty.

Capability flags gate actions. Unsupported approval or structured-input interactions are not
rendered as actionable controls.

Selection changes abort the old stream, increment the selected-session generation, load the
new persisted history, and ignore late events from the prior session.

## Workbench changed-file integration

`ProjectWorkbench` supplies an AI changed-file callback to `AiSessionTab`. The callback uses
the existing Git inspection data and Workbench open APIs:

- an existing staged/unstaged Git entry opens the existing Changes view with the safely
  derived diff kind;
- a path present only in staged status opens staged Changes;
- a path present only in unstaged status opens unstaged Changes;
- a path present in both staged and unstaged status does not guess the AI's intended diff and
  opens the normal Edit view or another existing neutral Workbench representation;
- otherwise an available non-deleted path opens the normal Edit view;
- a renamed file opens the current path while the AI presentation retains the old path;
- a deleted file opens Changes when representable, otherwise shows a safe unavailable state
  and never initiates a guaranteed-failing normal read.

No second editor or diff implementation is introduced.

## Testing and acceptance

Tests are written first for provider-private mapping, response claims, canonical projection,
exact authority validation, wrong/stale bindings, all approval decisions, complete
multi-question answers, ambiguous reconciliation, session generation guards, and changed-file
open behavior. Existing send/reconnect, interrupt, stop/restart, bounded history/output,
sequence, changed-file bounding, and provider cleanup tests remain passing.

A deterministic Playwright flow covers session navigation, approval/question cards, resolved
states, and changed-file callbacks with route fixtures. That test is supplementary: the
actual browser path is also dogfooded against real Codex when the local environment supports
the pinned provider.

## Implementation-agent/model orchestration

- Use Luna-family models only for implementation and any implementation subagents.
- The primary implementation model is Luna Max; Luna High or Luna Max may handle bounded
  subtasks according to consequence and complexity.
- Do not route implementation or review work to Terra, Sol, Astra, Gemini, or another model
  family.
- Subagent-driven development is optional and should be used only for genuinely separable
  tasks.
- Do not create a review cascade. Each subtask implements, runs focused tests, and self-checks
  once.
- Perform one focused review at a meaningful security/authority integration boundary where
  needed and one final integrated review before completion.
- Re-review only code materially changed in response to substantive findings.
- Follow the rapid-alpha rule: fix substantive findings once, verify, dogfood, and move on
  instead of entering iterative perfection loops.

## T3 Code usage

The inspected reference is `pingdotgg/t3code` at revision
`d1d15c67f4a5fb82fd8d5e01e5e3b288296789c3`. Checkpoint 2 uses its approval-card,
structured-question, quieter-activity, changed-file-link, and reconnect-state patterns as
conceptual UX inspiration only. No T3 source architecture is adopted and no source code is
copied unless a later implementation change explicitly records the exact file and MIT notice.
