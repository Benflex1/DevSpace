# AI Workbench / AI Session Beta Checkpoint 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the bounded browser Codex workflow for approvals, structured questions,
session selection, canonical interaction recovery, and Workbench changed-file navigation.

**Architecture:** Keep provider-native request IDs inside the Agent's active Codex adapter.
The Agent generates DevSpace-owned interaction IDs and emits safe canonical events; Web
atomically projects those events into the existing SQLite interaction table and authorizes
responses from the persisted session binding plus the current Agent profile. A single browser
projection reducer hydrates persisted interactions and applies replay/live events, while
ProjectWorkbench remains the only editor/diff authority.

**Tech Stack:** TypeScript, Next.js App Router, React 19, Node JSON-RPC over bounded stdio,
Zod contracts, Drizzle/better-sqlite3, Vitest, and Playwright.

**Spec:** `docs/superpowers/specs/2026-09-12-ai-workbench-checkpoint-2-design.md`

## Global Constraints

- Base is exactly `47bf2d8c70dcab7b2ff278eb241e927db02a6dd0` on branch `feat/ai-workbench-checkpoint-2`.
- Use Luna-family models only; primary implementation is Luna Max. No Terra, Sol, Astra, Gemini, or other model family is used for implementation or review work.
- Web remains the sole SQLite writer; the browser supplies only route-bound DevSpace IDs and bounded decisions/answers.
- Provider-native request IDs, command/file content, executable details, profile revisions, and process generations never come from or become browser authority.
- No ambient host Codex configuration is changed; `on-request` is scoped to the managed Agent-owned Codex process/session and is part of its profile revision.
- Canonical requested/responded/retirement projection is atomic with canonical event append and idempotent under duplicate events.
- An ambiguous interaction response is never retried blindly. It is reconciled to a same-generation synchronization boundary and exact Agent-owned DevSpace binding; otherwise it remains or becomes non-actionable.
- Existing sessions stay pinned to their stored profile revision. Stopped/lost/failed history is selectable but never restarted under a different revision.
- No second editor/diff implementation, multiple providers, chat-management suite, branch management, or deployment behavior is added.
- Each task uses RED → verify RED → GREEN → verify GREEN → self-check once. There is one focused authority review and one final integrated review, with no review cascade.

---

### Task 1: Add safe Codex interaction mapping and synchronization proof

**Files:**
- Create: `apps/agent/src/codex-interactions-v0-145.ts`
- Create: `apps/agent/src/codex-interactions-v0-145.test.ts`
- Modify: `apps/agent/src/codex-notification-schema-v0-145.ts`
- Modify: `apps/agent/src/ai-session-runtime.ts`
- Modify: `apps/agent/src/server.ts`
- Modify: `packages/contracts/src/ai-sessions.ts`
- Modify: `packages/contracts/src/ai-sessions.test.ts` or the existing AI contract test file

**Interfaces:**
- `parseCodexInteractionRequest(message: unknown)` accepts only the pinned command-approval,
  file-change-approval, and tool-user-input request shapes and returns an Agent-private native
  request descriptor without exposing its JSON-RPC ID.
- `projectCodexApprovalRequest(input)` returns a bounded DevSpace approval presentation.
- `projectCodexInputRequest(input)` returns bounded provider-neutral questions and an internal
  mapping from public question/option IDs to Codex-native question IDs/labels.
- `encodeCodexApprovalResponse(kind, decision)` and `encodeCodexInputResponse(mapping, answers)`
  return provider-native JSON-RPC result objects only inside the Agent adapter.
- Extend `stream.synchronized` with safe DevSpace metadata: `processGeneration` and a bounded
  `pendingInteractionIds` list. No native request ID is included.

**Steps:**

- [ ] **Step 1: Write the failing tests.** Add cases proving command/file/input requests
  produce a new DevSpace UUID distinct from a numeric native ID, presentations contain only
  safe bounded fields, secret input is rejected, generated option IDs bind to one exact
  question, and native response encoding maps each of the four approval decisions correctly.
  Add a contract test requiring synchronized frames to validate the process generation and
  bounded DevSpace pending-ID list.

- [ ] **Step 2: Run the focused tests to verify RED.**

  ```bash
  pnpm exec vitest run apps/agent/src/codex-interactions-v0-145.test.ts packages/contracts/src/ai-sessions.test.ts
  ```

  Expected result: failure because the new mapper and synchronization fields do not yet exist.

- [ ] **Step 3: Implement the private mapper.** Validate the pinned fixture shape before
  projection, canonicalize only workspace-relative paths, bound summaries/command text/path
  counts, classify command risk conservatively, and reject unsupported/secret requests. Keep
  the native request ID in an internal descriptor only. Use stable generated public IDs for
  Codex questions/options where Codex does not provide IDs, with a private reverse mapping.

- [ ] **Step 4: Add synchronization metadata.** Update the stream frame schema and Agent
  synchronization construction so the frame reports the current process generation and only
  DevSpace interaction IDs that still have an Agent-owned provider binding. Bound the list to
  the existing interaction retention limit and return an empty list for a non-live/lost
  binding.

- [ ] **Step 5: Run the focused tests to verify GREEN.**

  ```bash
  pnpm exec vitest run apps/agent/src/codex-interactions-v0-145.test.ts packages/contracts/src/ai-sessions.test.ts
  ```

  Expected result: all mapper and frame-contract tests pass.

- [ ] **Step 6: Self-check the diff.** Confirm no provider-native ID appears in the public
  mapper return type, canonical event payload, synchronization frame, or test browser fixture.

- [ ] **Step 7: Commit.**

  ```bash
  git add apps/agent/src/codex-interactions-v0-145.ts apps/agent/src/codex-interactions-v0-145.test.ts apps/agent/src/codex-notification-schema-v0-145.ts apps/agent/src/ai-session-runtime.ts packages/contracts/src/ai-sessions.ts packages/contracts/src/ai-sessions.test.ts
  git commit -m "feat: add private Codex interaction projections"
  ```

### Task 2: Wire Agent deferred responses and scoped Codex approvals

**Files:**
- Modify: `apps/agent/src/ai-session-runtime.ts`
- Modify: `apps/agent/src/server.ts`
- Modify: `apps/web/src/server/agent-client.ts`
- Modify: `apps/agent/src/ai-session-runtime.test.ts`
- Modify: `apps/agent/src/ai-session-server.test.ts` or the existing Agent HTTP test file

**Interfaces:**
- `AiSessionRuntime.respondToApproval(input: AiProcessBinding & { turnId: string; requestId: string; decision: AiApprovalDecision }): Promise<void>`.
- `AiSessionRuntime.respondToStructuredInput(input: AiProcessBinding & { turnId: string; requestId: string; answers: AiStructuredInputAnswer[] }): Promise<void>`.
- `FullAgentClient.respondToAiApproval(operationId, data)` and
  `FullAgentClient.respondToAiStructuredInput(operationId, data)` use the already-registered
  `ai-session.approval.respond` and `ai-session.input.respond` operations.
- The Agent-private adapter stores `{devspaceRequestId, nativeRequestId, turnId, kind,
  responseClaimed}` and resolves exactly once. Provider response writes happen only after a
  claim; a second claim fails with `ai-interaction-state-conflict`.

**Steps:**

- [ ] **Step 1: Write failing runtime tests.** Drive the fake JSON-RPC protocol with each
  supported server request and assert the canonical requested event uses a DevSpace UUID,
  the native request is suspended, the response method resumes it with the expected native
  result, and a second response cannot write another native response. Assert process
  generation/profile binding mismatches fail before provider I/O.

- [ ] **Step 2: Run the focused runtime tests to verify RED.**

  ```bash
  pnpm exec vitest run apps/agent/src/ai-session-runtime.test.ts -t "interaction|approval|input|provider request"
  ```

- [ ] **Step 3: Implement deferred native request handling.** Extend the Codex adapter
  request classifier to distinguish server requests from notifications and responses. Route
  only the three supported methods to the private mapper. Have the runtime allocate the
  DevSpace request ID, emit the canonical requested event, retain the provider binding, and
  await a single Web-authorized response. Mark the turn as `waiting-for-approval` or
  `waiting-for-input` while waiting and back to running after a confirmed native response.

- [ ] **Step 4: Enable scoped `on-request`.** Change only the managed Codex `thread/start`
  authority and profile constants used by the Agent-owned process. Update the authority hash
  and advertised capabilities to `approvals: true` and `structuredInput: true`; preserve
  the existing runtime/workspace identity in the profile revision so another workspace or
  ambient host configuration is untouched.

- [ ] **Step 5: Expose the two exact Agent operations.** Add them to the Agent mutation
  dispatch list, call the new runtime methods, map interaction conflicts, capability
  failures, turn conflicts, identity mismatches, and provider failures to the existing F11
  error policy, and add the two typed client methods. Do not add a second transport family.

- [ ] **Step 6: Run focused tests to verify GREEN.**

  ```bash
  pnpm exec vitest run apps/agent/src/ai-session-runtime.test.ts apps/agent/src/ai-session-server.test.ts apps/web/src/server/agent-client.test.ts
  ```

- [ ] **Step 7: Self-check the authority path.** Inspect request/response logs and test data
  for native IDs, native command payloads, credentials, or provider configuration crossing
  the Agent/Web boundary. Confirm `on-request` is present only in the managed process start
  payload and the persisted profile revision calculation.

- [ ] **Step 8: Commit.**

  ```bash
  git add apps/agent/src/ai-session-runtime.ts apps/agent/src/server.ts apps/web/src/server/agent-client.ts apps/agent/src/ai-session-runtime.test.ts apps/agent/src/ai-session-server.test.ts apps/web/src/server/agent-client.test.ts
  git commit -m "feat: wire Codex approval and input responses"
  ```

### Task 3: Project interactions atomically in SQLite and retire stale requests

**Files:**
- Modify: `apps/web/src/server/database.ts`
- Modify: `apps/web/src/server/ai-sessions.ts` only if database-facing types need re-exporting
- Modify: `apps/web/src/server/ai-sessions.test.ts`
- Modify: `packages/domain/src/ai-session-lifecycles.ts` only if existing transition helpers lack the already-defined edges
- Modify: `packages/database/src/schema.ts` only if the current schema definitions do not expose the existing table/state types
- Modify: database migration files only if a schema check proves a required non-state projection field is missing

**Interfaces:**
- `ProjectDatabase.getAiInteraction(projectId, workspaceId, sessionId, turnId, requestId)` returns the exact bounded public interaction row or `null`.
- `ProjectDatabase.retireAiInteractions(input: { projectId; workspaceId; sessionId; turnId?: string; state: "cancelled" | "expired" | "lost" })` atomically retires pending rows for an exact terminal owner.
- `commitAiEvent` remains the single transaction boundary: event append, turn projection,
  interaction request/response projection, pending retirement, compaction, and session update
  all happen inside the same immediate transaction.

**Steps:**

- [ ] **Step 1: Write failing database projection tests.** Add tests for requested approval
  and input events inserting one pending row, response events updating that same row, request
  before response and response-before-request replay convergence, duplicate canonical events
  not duplicating rows, and malformed/wrong-kind responses failing closed.

- [ ] **Step 2: Add failing terminal-retirement tests.** Prove a `turn.lost`, `turn.interrupted`,
  `turn.failed`, `turn.quiesced`, `session.stopped`, and `session.lost` path retires owned
  pending requests with the existing lifecycle state matching the cause. Prove refresh data
  never returns a lost/terminal pending interaction as actionable, while a later canonical
  responded event can still be recognized as authoritative and rendered resolved.

- [ ] **Step 3: Run the focused database tests to verify RED.**

  ```bash
  pnpm exec vitest run apps/web/src/server/ai-sessions.test.ts -t "interaction|retir|canonical"
  ```

- [ ] **Step 4: Implement the atomic projection.** Import the existing
  `aiInteractionRequests` table, parse only the public contract payloads, insert on requested
  events, update by exact `{id, sessionId, turnId, kind}` on responded events, and keep
  response rows bounded. Make duplicate event repair idempotent without advancing the event
  sequence. Update turn state to the existing waiting states and back to running/terminal
  states as canonical events dictate.

- [ ] **Step 5: Implement terminal retirement.** In the same event transaction, update only
  pending interactions owned by the exact turn/session. Use `cancelled` for explicit
  interruption/cancellation, `lost` for provider/session loss, and `expired` only for an
  actual existing expiry path. Keep resolved/retired rows in history and exclude them from
  actionable response queries.

- [ ] **Step 6: Expose exact interaction reads.** Return parsed bounded request/response
  projections and the existing interaction-history truncation signal. Never return provider
  native binding fields.

- [ ] **Step 7: Run focused tests to verify GREEN.**

  ```bash
  pnpm exec vitest run apps/web/src/server/ai-sessions.test.ts -t "interaction|retir|canonical"
  ```

- [ ] **Step 8: Self-check transaction boundaries and state transitions.** Verify the event
  insert cannot commit without its interaction projection, no pending row survives a terminal
  owner, and no response event can create a new interaction row without its request event.

- [ ] **Step 9: Commit.**

  ```bash
  git add apps/web/src/server/database.ts apps/web/src/server/ai-sessions.test.ts packages/domain/src/ai-session-lifecycles.ts packages/database/src/schema.ts packages/database/src/migrations
  git commit -m "feat: project AI interactions atomically"
  ```

### Task 4: Correct profile-pinned session creation and lease idempotency

**Files:**
- Modify: `apps/web/src/server/database.ts`
- Modify: `apps/web/src/server/ai-sessions.ts`
- Modify: `apps/web/src/server/ai-sessions.test.ts`
- Modify: `apps/web/src/app/ai-session-load.ts` only if selected-session loading needs to distinguish historical sessions

**Interfaces:**
- `createInitialAiSession` returns the existing current nonterminal Codex session when one
  exists, otherwise creates a new row bound to the inspected current profile revision.
- Terminal states (`stopped`, `failed`, `lost`) are historical and do not block a new
  current-revision session. A live/creating/waiting/active/interrupted session remains the
  one-live-provider lease winner even if its stored revision is older than the current profile.
- `restartAiSession` continues to require exact stored `profileId/profileRevision`, runtime
  revision, and workspace runtime identity; mismatch is historical-only, never migration.

**Steps:**

- [ ] **Step 1: Write failing lifecycle tests.** Cover: existing active/creating session is
  reused; concurrent create calls return one session; an old stopped session does not block a
  new current-profile session; an old lost session remains selectable but cannot restart; an
  existing live session on an older revision is reused rather than duplicated; a stopped
  current-revision session is not silently restarted by Create.

- [ ] **Step 2: Run the focused lifecycle tests to verify RED.**

  ```bash
  pnpm exec vitest run apps/web/src/server/ai-sessions.test.ts -t "Create|create|profile revision|stopped|lost|concurrent"
  ```

- [ ] **Step 3: Change the database selection predicate.** Replace the current “any Codex
  row wins” lookup with a transactionally ordered lookup of current nonterminal states. Leave
  all terminal history rows untouched. If no current row exists, insert a new row using the
  supplied current profile revision and runtime binding.

- [ ] **Step 4: Preserve create reconciliation.** Keep the existing initial-session attempt
  coordinator keyed by the selected/new session ID. Ensure an ambiguous start for a newly
  created row reuses that exact row on retry and never creates a second live process. Ensure
  a historical row selected for inspection is not passed to `startAiSession`.

- [ ] **Step 5: Run focused tests to verify GREEN.**

  ```bash
  pnpm exec vitest run apps/web/src/server/ai-sessions.test.ts -t "Create|create|profile revision|stopped|lost|concurrent"
  ```

- [ ] **Step 6: Self-check revision semantics.** Trace `inspectAiProvider` → database create
  binding → Agent start binding and confirm no update mutates an existing session's profile
  revision.

- [ ] **Step 7: Commit.**

  ```bash
  git add apps/web/src/server/database.ts apps/web/src/server/ai-sessions.ts apps/web/src/server/ai-sessions.test.ts apps/web/src/app/ai-session-load.ts
  git commit -m "fix: preserve profile-pinned AI session history"
  ```

### Task 5: Implement exact Web authority, answer validation, and canonical response reconciliation

**Files:**
- Create: `apps/web/src/server/ai-interaction-validation.ts`
- Create: `apps/web/src/server/ai-interaction-validation.test.ts`
- Modify: `apps/web/src/server/ai-sessions.ts`
- Modify: `apps/web/src/server/ai-sessions.test.ts`
- Modify: `apps/web/src/app/api/projects/[projectId]/ai/route.ts`
- Modify: `apps/web/src/app/api/projects/[projectId]/ai/route.test.ts` or the existing AI route test file

**Interfaces:**
- `validateStructuredInputAnswers(questions, answers)` requires one answer per exact
  question, rejects duplicate/missing question IDs, rejects selected options not belonging to
  that question, rejects selected answers for text questions, and rejects text answers for
  single-select questions.
- `respondToAiApproval(projectId, workspaceId, sessionId, turnId, requestId, decision, dependencies)`.
- `respondToAiStructuredInput(projectId, workspaceId, sessionId, turnId, requestId, answers, dependencies)`.
- `reconcileAiInteractionResponse(...)` consumes Agent frames until the target responded event
  or a synchronization boundary. It accepts a response only when the event is canonical or
  the exact same-generation pending DevSpace binding is positively present in the sync frame.

**Steps:**

- [ ] **Step 1: Write failing answer-validation tests.** Cover valid single-select, valid
  text, multi-question answers, missing answer, extra answer, wrong question ID, foreign
  option ID, wrong response kind, duplicate question IDs, and a secret question rejection.

- [ ] **Step 2: Write failing authority tests.** Cover wrong project/workspace/session/turn/
  request binding, already-responded/retired request, approval-vs-input mismatch, unavailable
  current capability, current profile revision mismatch, and browser-supplied binding fields
  being ignored/rejected. Assert no Agent method is called for every failed preflight.

- [ ] **Step 3: Write failing reconciliation tests.** Cover canonical responded event found
  after the Agent receipt, synchronization showing the exact same process generation and
  pending DevSpace ID, synchronization showing a different generation/no pending binding,
  and Agent transport failure before synchronization. Assert an ambiguous case never calls
  the provider response method a second time; unresolved binding is retired/non-actionable
  using the existing `lost` lifecycle state, while proven pending remains actionable.

- [ ] **Step 4: Run focused tests to verify RED.**

  ```bash
  pnpm exec vitest run apps/web/src/server/ai-interaction-validation.test.ts apps/web/src/server/ai-sessions.test.ts apps/web/src/app/api/projects/'[projectId]'/ai/route.test.ts
  ```

- [ ] **Step 5: Implement strict Web preflight.** Inspect the current authoritative Agent
  profile first, require exact profile ID/revision match and the relevant capability, then
  resolve the route-bound persisted session, exact turn, exact interaction kind, and pending
  lifecycle state. Derive process generation/profile revision from that stored session and
  send only the DevSpace ID plus bounded decision/answers to Agent.

- [ ] **Step 6: Implement canonical reconciliation.** After an accepted response, consume
  canonical events and commit them through the existing stream path. Use the synchronized
  frame's process generation and pending DevSpace IDs as the positive same-generation binding
  proof. If the target responded event exists, return resolved. If exact pending proof exists,
  leave it pending/actionable. If the binding disappears or synchronization is unavailable,
  retire the interaction as `lost` and return a reconciliation-required conflict. Never call
  the Agent response method again from reconciliation.

- [ ] **Step 7: Extend strict API parsing.** Add only `respond-approval` and `respond-input`
  action shapes with exact allowed keys. Parse decisions/answers against the bounded contracts,
  call the server service functions, preserve CSRF/auth handling, and map canonical AI failure
  codes to existing response statuses.

- [ ] **Step 8: Run focused tests to verify GREEN.**

  ```bash
  pnpm exec vitest run apps/web/src/server/ai-interaction-validation.test.ts apps/web/src/server/ai-sessions.test.ts apps/web/src/app/api/projects/'[projectId]'/ai/route.test.ts
  ```

- [ ] **Step 9: Perform the focused authority review.** Review only the Web/Agent interaction
  boundary and its tests against the five hard amendments: profile pinning, current capability
  authority, no native IDs, atomic projection/retirement, and no ambiguous resend. Fix any
  substantive finding once and rerun this task's tests.

- [ ] **Step 10: Commit.**

  ```bash
  git add apps/web/src/server/ai-interaction-validation.ts apps/web/src/server/ai-interaction-validation.test.ts apps/web/src/server/ai-sessions.ts apps/web/src/server/ai-sessions.test.ts apps/web/src/app/api/projects/'[projectId]'/ai/route.ts apps/web/src/app/api/projects/'[projectId]'/ai/route.test.ts
  git commit -m "feat: authorize and reconcile AI interactions"
  ```

### Task 6: Build deterministic browser interaction projection and replay

**Files:**
- Create: `apps/web/src/app/ai-session-interactions.ts`
- Create: `apps/web/src/app/ai-session-interactions.test.ts`
- Modify: `apps/web/src/app/ai-session-projection.ts`
- Modify: `apps/web/src/app/ai-session-replay.ts`
- Modify: `apps/web/src/app/ai-session-projection.test.ts`
- Modify: `apps/web/src/app/ai-session-replay.test.ts` or the current replay test file

**Interfaces:**
- `BrowserAiInteraction` includes only public DevSpace request ID, turn ID, kind, public
  presentation/questions, lifecycle state, bounded response, and a derived
  `reconciliationRequired` flag for conservatively retired/lost interactions.
- `applyAiInteractionEvent(interactions, event)` upserts requested/responded interactions by
  DevSpace ID, accepts response-after-request and response-before-request replay deterministically,
  and never duplicates canonical events.
- `hydrateAiInteractions(rows)` parses persisted rows and marks only pending, proven-bound
  interactions actionable; responded/cancelled/expired rows are non-actionable, while lost
  rows are shown as reconciliation-required and non-actionable.

**Steps:**

- [ ] **Step 1: Write failing projection/replay tests.** Cover approval requested → pending,
  approval responded → same resolved card, input requested with all questions, input responded
  → resolved, duplicate requested/responded events, response-before-request ordering,
  refresh/replay equivalence, old-session event rejection, and interaction-history truncation.

- [ ] **Step 2: Run focused projection tests to verify RED.**

  ```bash
  pnpm exec vitest run apps/web/src/app/ai-session-interactions.test.ts apps/web/src/app/ai-session-projection.test.ts apps/web/src/app/ai-session-replay.test.ts
  ```

- [ ] **Step 3: Implement the shared reducer.** Keep interactions nested by turn, copy arrays
  before mutation, use public contract parsing/guards, preserve bounded/truncated metadata,
  and make resolved/retired states permanently non-actionable. Use the same reducer from
  initial persisted hydration, event replay, and live `AiSessionTab` handling.

- [ ] **Step 4: Run focused tests to verify GREEN.**

  ```bash
  pnpm exec vitest run apps/web/src/app/ai-session-interactions.test.ts apps/web/src/app/ai-session-projection.test.ts apps/web/src/app/ai-session-replay.test.ts
  ```

- [ ] **Step 5: Self-check browser data.** Confirm no provider-native fields, executable
  details, profile revision authority, or process generation enters `BrowserAiInteraction`.

- [ ] **Step 6: Commit.**

  ```bash
  git add apps/web/src/app/ai-session-interactions.ts apps/web/src/app/ai-session-interactions.test.ts apps/web/src/app/ai-session-projection.ts apps/web/src/app/ai-session-replay.ts apps/web/src/app/ai-session-projection.test.ts apps/web/src/app/ai-session-replay.test.ts
  git commit -m "feat: project AI interactions in the browser"
  ```

### Task 7: Render approvals and structured questions inline

**Files:**
- Create: `apps/web/src/app/ai-session-interaction-cards.tsx`
- Create: `apps/web/src/app/ai-session-interaction-cards.test.ts`
- Modify: `apps/web/src/app/ai-session-tab.tsx`
- Modify: `apps/web/src/app/ai-session-notices.tsx`
- Modify: `apps/web/src/app/ai-session-tab.test.ts`
- Modify: `apps/web/src/app/styles.css`

**Interfaces:**
- `AiSessionInteractionCards` renders a pending command/file approval or structured-input
  request and a compact resolved/retired state; it receives public interaction data and a
  single bounded response callback.
- `AiSessionTab` response state is keyed by DevSpace request ID, disables only that card while
  submitting, and rejects duplicate clicks before POST.

**Steps:**

- [ ] **Step 1: Write failing UI projection tests or source-level regression tests.** Assert
  command cards show summary, exact safe command text, working directory, risk, and only four
  allowed action labels; file cards show bounded paths/truncation; input cards show every
  question, labels/descriptions, one selection or text control; resolved cards contain no
  actionable controls; unsupported capabilities show no impossible action.

- [ ] **Step 2: Run focused tests to verify RED.**

  ```bash
  pnpm exec vitest run apps/web/src/app/ai-session-tab.test.ts apps/web/src/app/ai-session-interaction-cards.test.ts
  ```

- [ ] **Step 3: Implement cards and answer collection.** Use clear inline semantics, quiet
  activity styling, complete-answer validation, compact pending/resolved labels, and no secret
  input. Post the entire exact answer set once for a multi-question request. Keep pending
  response state independent of event/reload projection so canonical response confirmation
  retires controls exactly once.

- [ ] **Step 4: Wire the shared reducer into `AiSessionTab`.** Hydrate `selected.session.interactions`,
  apply requested/responded events through the same reducer as replay, and render cards under
  their owning turn. Show interaction-history truncation and reconciliation-required notices.

- [ ] **Step 5: Run focused tests to verify GREEN.**

  ```bash
  pnpm exec vitest run apps/web/src/app/ai-session-tab.test.ts apps/web/src/app/ai-session-interaction-cards.test.ts
  ```

- [ ] **Step 6: Self-check accessibility and protocol surface.** Verify labels are associated,
  keyboard selection works, action buttons use contract labels, and the browser POST bodies
  contain no presentation/provider authority fields.

- [ ] **Step 7: Commit.**

  ```bash
  git add apps/web/src/app/ai-session-interaction-cards.tsx apps/web/src/app/ai-session-interaction-cards.test.ts apps/web/src/app/ai-session-tab.tsx apps/web/src/app/ai-session-notices.tsx apps/web/src/app/ai-session-tab.test.ts apps/web/src/app/styles.css
  git commit -m "feat: add inline AI approval and question cards"
  ```

### Task 8: Add small truthful session navigation and generation guards

**Files:**
- Create: `apps/web/src/app/ai-session-navigator.tsx`
- Modify: `apps/web/src/app/ai-session-tab.tsx`
- Modify: `apps/web/src/app/ai-session-load.ts`
- Modify: `apps/web/src/app/ai-session-load.test.ts` or the existing coordinator test file
- Modify: `apps/web/src/app/ai-session-tab.test.ts`
- Modify: `apps/web/src/app/styles.css`

**Interfaces:**
- `AiSessionNavigator` receives persisted summaries, selected ID, current profile revision,
  lease state, and callbacks for select/create.
- Selection increments the existing `selectionGeneration`, aborts load/stream controllers,
  binds the new session, and ignores late events from the previous session.

**Steps:**

- [ ] **Step 1: Write failing navigation tests.** Cover selected-session indication, exact
  persisted history load, old-stream abort on switch, late old-session event ignored, create
  reuse of an existing current nonterminal session, creation after stopped/lost history, and
  disabled/rejected creation while the one-live-provider lease is occupied.

- [ ] **Step 2: Run focused tests to verify RED.**

  ```bash
  pnpm exec vitest run apps/web/src/app/ai-session-load.test.ts apps/web/src/app/ai-session-tab.test.ts -t "session|selection|stream|create"
  ```

- [ ] **Step 3: Implement the navigator.** Show persisted sessions with title, coarse state,
  selected styling, and profile-revision mismatch as historical/read-only context. Do not add
  folders, search, rename, pin, delete, or parallel live sessions. Disable Create when a
  current nonterminal session is already selected/owned and let the server remain authoritative.

- [ ] **Step 4: Preserve generation guards.** Store session summaries from the inspection
  response, pass the chosen ID to the exact load query, abort the old stream before loading,
  reset turn/interactions only after the new load is current, and reject stale event/session IDs
  in the existing callback.

- [ ] **Step 5: Run focused tests to verify GREEN.**

  ```bash
  pnpm exec vitest run apps/web/src/app/ai-session-load.test.ts apps/web/src/app/ai-session-tab.test.ts -t "session|selection|stream|create"
  ```

- [ ] **Step 6: Self-check truthful states.** Confirm a stopped/lost historical session has
  inspection/restart messaging but cannot be silently rebound to the current profile, and a
  live lease conflict is visible rather than hidden by the navigator.

- [ ] **Step 7: Commit.**

  ```bash
  git add apps/web/src/app/ai-session-navigator.tsx apps/web/src/app/ai-session-tab.tsx apps/web/src/app/ai-session-load.ts apps/web/src/app/ai-session-load.test.ts apps/web/src/app/ai-session-tab.test.ts apps/web/src/app/styles.css
  git commit -m "feat: navigate persisted AI sessions"
  ```

### Task 9: Integrate AI changed files with the existing Workbench

**Files:**
- Create: `apps/web/src/app/ai-changed-file-open.ts`
- Create: `apps/web/src/app/ai-changed-file-open.test.ts`
- Modify: `apps/web/src/app/ai-session-tab.tsx`
- Modify: `apps/web/src/app/project-workbench.tsx`
- Modify: `apps/web/src/app/workspace-changes-state.ts` only if a safe shared lookup belongs there
- Create: `apps/web/src/app/project-workbench.test.ts` if no existing Workbench test file covers the callback

**Interfaces:**
- `resolveAiChangedFileOpen(status, file)` returns `{ mode: "changes", path, diffKind }`,
  `{ mode: "edit", path }`, or `{ mode: "unavailable", path, reason }`.
- `ProjectWorkbench` passes `onOpenAiChangedFile(file)` to `AiSessionTab`; it owns the final
  call to `openEditorTab` and existing Changes/editor tab state.

**Steps:**

- [ ] **Step 1: Write failing changed-file tests.** Cover exact path only staged → staged
  Changes, only unstaged → unstaged Changes, both staged and unstaged → normal Edit/neutral
  view without guessing, renamed → current path, deleted with Git entry → Changes, deleted
  without Git entry → unavailable, and clean non-deleted path → normal Edit.

- [ ] **Step 2: Run focused tests to verify RED.**

  ```bash
  pnpm exec vitest run apps/web/src/app/ai-changed-file-open.test.ts apps/web/src/app/project-workbench.test.ts
  ```

- [ ] **Step 3: Implement the pure lookup.** Use `GitStatusEntry.path`, `oldPath`,
  `stagedState`, and `unstagedState`; treat both non-unchanged statuses as ambiguous. Never
  call `editorDocuments.ensure` for a deleted/unavailable result.

- [ ] **Step 4: Wire the callback.** Replace plain changed-file code text with accessible
  buttons that retain old-path presentation for renames. Delegate changes/edit opening to
  existing Workbench APIs and show a safe notice for unavailable files.

- [ ] **Step 5: Run focused tests to verify GREEN.**

  ```bash
  pnpm exec vitest run apps/web/src/app/ai-changed-file-open.test.ts apps/web/src/app/project-workbench.test.ts
  ```

- [ ] **Step 6: Self-check scope.** Confirm AI does not call Git, read files directly, create
  a second diff, or infer staging state from the AI summary.

- [ ] **Step 7: Commit.**

  ```bash
  git add apps/web/src/app/ai-changed-file-open.ts apps/web/src/app/ai-changed-file-open.test.ts apps/web/src/app/ai-session-tab.tsx apps/web/src/app/project-workbench.tsx apps/web/src/app/workspace-changes-state.ts apps/web/src/app/project-workbench.test.ts
  git commit -m "feat: open AI changed files in Workbench"
  ```

### Task 10: Extend deterministic fake-provider acceptance coverage

**Files:**
- Modify: `apps/agent/src/ai-session-runtime.ts`
- Modify: `apps/agent/src/ai-session-runtime.test.ts`
- Modify: `apps/agent/test/e2e-server.ts` only if deterministic fake hooks need explicit wiring
- Modify: `e2e/z-ai-session.spec.ts`
- Create: `e2e/ai-workbench-interactions.spec.ts`

**Interfaces:**
- Fake-provider prompts trigger deterministic command approval, file-change approval, and
  multi-question input requests through the same Agent callbacks as Codex. The fixture never
  writes the database directly and never exposes provider-private IDs.

**Steps:**

- [ ] **Step 1: Write failing runtime/E2E expectations.** Add deterministic prompts for
  approve-once, deny, multi-question input, and changed-file navigation. Assert the browser
  can see the request, answer it once, see the resolved state, and observe continued output.

- [ ] **Step 2: Run the targeted tests to verify RED.**

  ```bash
  pnpm exec vitest run apps/agent/src/ai-session-runtime.test.ts -t "fake.*interaction"
  pnpm exec playwright test e2e/ai-workbench-interactions.spec.ts --project=chromium
  ```

- [ ] **Step 3: Extend the fake provider only as a deterministic test fixture.** Reuse the
  same deferred interaction callback and canonical event path; do not add fake-only browser
  APIs or database writes.

- [ ] **Step 4: Add the browser flow.** Open the fixture project/workspace, create/select a
  session, approve once, deny a second request, answer all structured questions, click a
  changed file, refresh, switch to a second persisted session after stopping the first, and
  confirm the old session's late events do not change the selected UI.

- [ ] **Step 5: Run targeted tests to verify GREEN.**

  ```bash
  pnpm exec vitest run apps/agent/src/ai-session-runtime.test.ts -t "fake.*interaction"
  pnpm exec playwright test e2e/ai-workbench-interactions.spec.ts --project=chromium
  ```

- [ ] **Step 6: Self-check acceptance honesty.** Keep the fake-provider test explicitly named
  deterministic fixture coverage; do not describe it as real Codex acceptance.

- [ ] **Step 7: Commit.**

  ```bash
  git add apps/agent/src/ai-session-runtime.ts apps/agent/src/ai-session-runtime.test.ts apps/agent/test/e2e-server.ts e2e/z-ai-session.spec.ts e2e/ai-workbench-interactions.spec.ts
  git commit -m "test: cover AI Workbench interactions in browser"
  ```

### Task 11: Update durable status documentation and T3 usage record

**Files:**
- Modify: `docs/current-state.md`
- Modify: `docs/roadmap.md`
- Modify: `docs/attributions/t3code-ai-session.md`

**Steps:**

- [ ] **Step 1: Write a documentation checklist test by searching stale claims.** Identify
  the Workbench 1B “active” references and Checkpoint 2 “deferred” references that must change.

  ```bash
  rg -n "Workbench 1B|Checkpoint 2|approvals|structured questions|deferred|active" docs/current-state.md docs/roadmap.md docs/attributions/t3code-ai-session.md
  ```

- [ ] **Step 2: Update only the affected status sections.** Record Checkpoint 2 approvals,
  structured questions, session navigation, changed-file integration, profile-pinned history,
  and remaining beta limitations. Mark Workbench 1B merged after PR #49 without rewriting
  roadmap history. Record T3 revision `d1d15c67f4a5fb82fd8d5e01e5e3b288296789c3` as
  conceptual UX inspiration unless implementation actually copies a source file.

- [ ] **Step 3: Run documentation checks.**

  ```bash
  git diff --check
  rg -n "Workbench 1B.*active|approvals.*deferred|structured.*deferred" docs/current-state.md docs/roadmap.md || true
  ```

- [ ] **Step 4: Self-check authority language.** Ensure docs do not claim current sessions
  migrate profiles, that capability flags are SQLite-persisted, or that fake E2E is real Codex.

- [ ] **Step 5: Commit.**

  ```bash
  git add docs/current-state.md docs/roadmap.md docs/attributions/t3code-ai-session.md
  git commit -m "docs: record AI Workbench Checkpoint 2 status"
  ```

### Task 12: Full verification, real Codex dogfood, final review, push, and PR

**Files:**
- No planned production file changes; only test fixes or substantive review corrections

**Steps:**

- [ ] **Step 1: Run focused suites once more from the integrated branch.**

  ```bash
  pnpm exec vitest run apps/agent/src/ai-session-runtime.test.ts apps/web/src/server/ai-sessions.test.ts apps/web/src/app/ai-session-interactions.test.ts apps/web/src/app/ai-changed-file-open.test.ts
  pnpm exec playwright test e2e/ai-workbench-interactions.spec.ts e2e/z-ai-session.spec.ts --project=chromium
  ```

- [ ] **Step 2: Dogfood real Codex in the browser.** Use the actual local Codex authority and
  the browser only: create/select a session, trigger a safe command approval and approve once,
  trigger another approval and deny it, trigger structured questions and answer them, change
  a file, open it through Workbench, refresh, switch sessions where the lease permits,
  interrupt a turn, and send another turn. Record whether the environment could produce all
  three interaction types; if the pinned protocol materially differs, stop and report the
  exact mismatch instead of changing contracts.

- [ ] **Step 3: Run the required full verification contract.**

  ```bash
  pnpm install --frozen-lockfile
  pnpm workspace:check
  pnpm lint
  pnpm test
  pnpm typecheck
  pnpm build
  pnpm contracts:check
  pnpm schema:check
  pnpm db:migrate:test
  pnpm db:check
  git diff --check origin/main...HEAD
  ```

- [ ] **Step 4: Perform the final integrated review once.** Review the complete diff against
  the spec and hard amendments, with special attention to provider-private IDs, exact profile
  lifecycle, atomic projection/retirement, ambiguous no-resend behavior, lease truthfulness,
  and staged/unstaged ambiguity. Fix substantive findings once, rerun focused tests and the
  affected full check, then stop review iteration.

- [ ] **Step 5: Verify branch/status evidence.**

  ```bash
  git diff --check origin/main...HEAD
  git status --short
  git rev-parse HEAD
  git rev-parse origin/main
  ```

- [ ] **Step 6: Push without force and open the PR without merging.**

  ```bash
  git push -u origin feat/ai-workbench-checkpoint-2
  gh pr create --base main --head feat/ai-workbench-checkpoint-2 --title "feat: AI Workbench Checkpoint 2" --body-file /tmp/devspace-ai-workbench-checkpoint-2-pr.md
  ```

  The PR body must summarize the reused foundation, authority/reconciliation path, browser
  UX, Workbench integration, tests, full verification, Playwright, real Codex result, and
  deferred beta limitations. Do not merge the PR or force-push.
