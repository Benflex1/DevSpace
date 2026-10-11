# Test-suite audit — 2026-10-10

Baseline: merged main `97be8e31f3bbe37ffd418399ec15fdd8525602c4` (PR #65).
Worktree: `/workspace/DevSpace-test-audit`; branch: `test/audit-first-cleanup`.
This is a complete file inventory with sampled content review, not a claim that every
assertion has been reviewed. The implementation is limited to the first conservative batch.

## Inventory and method

The accompanying [TSV](test-suite-2026-10-10.tsv) lists every test file, expanded case
count, and physical lines before/after. Vitest collection supplies expanded counts;
Node's JUnit reporter supplies tooling counts; Playwright collection supplies E2E counts.
The two environment-gated rootless cases are included even though local collection omits them.
Physical lines include comments and blank lines. The size comparison uses tracked
TS/TSX/JS/MJS/Rust code outside named test files, including helpers/tooling; it is approximate,
not a coverage measure. JSON fixtures and generated schemas are outside that denominator.

Baseline inventory (case counts include gated cases):

| Subsystem | Files | Cases | Test lines | Other code lines | Test / other |
| --- | ---: | ---: | ---: | ---: | ---: |
| apps/agent | 54 | 861 | 19603 | 21275 | 0.92 |
| apps/preview-gateway-host | 2 | 4 | 115 | 179 | 0.64 |
| apps/web | 67 | 545 | 11134 | 13290 | 0.84 |
| e2e | 5 | 11 | 930 | 0 | — |
| packages/contracts | 24 | 255 | 3324 | 4323 | 0.77 |
| packages/database | 2 | 10 | 658 | 1174 | 0.56 |
| packages/diagnostics | 1 | 7 | 106 | 341 | 0.31 |
| packages/domain | 8 | 1193 | 1365 | 1085 | 1.26 |
| packages/gateway-caddy | 2 | 37 | 576 | 987 | 0.58 |
| packages/project-options | 4 | 91 | 1329 | 1069 | 1.24 |
| packages/security | 7 | 254 | 986 | 969 | 1.02 |
| packages/testkit | 1 | 5 | 71 | 19 | 3.74 |
| tooling | 12 | 109 | 2012 | 6056 | 0.33 |

Named test files total 42,209 lines against 50,767 other code lines in these subsystems
(about 83%). Test helpers in the denominator make this a lower estimate of the full test
footprint relative to production. Counts and size alone are not deletion criteria.

## Reviewed findings and priorities

| Classification | Evidence and decision |
| --- | --- |
| Keep | `domain/lifecycle-graph-parity.test.ts`: independent specification rows exercise all 690 ordered pairs, including 245 allowed and 445 rejected edges. Keep every pair and the fixture integrity checks. `lifecycle-guards.test.ts` separately exercises contextual evidence and validation precedence; these are different contracts, not duplicate graph tests. Authority: `docs/specs/lifecycle-states.md`. |
| Keep | `agent/harness-isolation.test.ts` exercises actual private homes, cross-workspace lease refusal, and custom-harness environment isolation. `web/server/auth.test.ts` uses real signed JWT/JWKS verification and CSRF rejection. `database/{schema,migration}.test.ts` exercises real SQLite, migration history, constraints and idempotency. Size or overlap with integration tests does not justify deleting these. |
| Keep | Both `*.rootless.integration.test.ts` files and `.github/workflows/rootless-git-integration.yml`: real Docker semantics differ from fake engine behavior. CI explicitly fails if either acceptance case skips. |
| Keep | Agent runtime, Web persistence/orchestration, and browser AI flow tests operate at different boundaries. Agent finalization fault injection, Web event commits, and browser navigation/refresh are not interchangeable coverage. |
| Simplify/consolidate, first batch | Lifecycle fixture numeric totals duplicate values derivable from the independent rows and state Cartesian products. Remove numeric bookkeeping, retaining the rows, all behavioral cases, terminal-state checks, duplicate detection, endpoint membership, prohibition of self edges, and one fixed aggregate assertion for 17 lifecycles, 245 allowed edges and 690 ordered pairs. |
| Remove, first batch | `contracts/f10-inventory.test.ts` repeats the same four F09 classification assertions in `contracts/inventory.test.ts`. Retain the latter and every F10 route/error/schema/composition assertion. |
| Remove, first batch | `domain/lifecycle-encapsulation.test.ts`'s single `registering -> invalid` result repeats the exhaustive graph case. Its extra array checks follow directly from exact object equality. Keep export/type boundary and freezing/mutation refusal tests. |
| Remove, first batch | `domain/lifecycle-types.test.ts`'s last runtime case only compares a local constant to its own initializer. Keep the adjacent compile-time rejection function and all `@ts-expect-error` assertions; package typecheck includes this file. |
| Simplify/consolidate, first batch | PR #65's session-listing test installs a delayed implementation for a mock it proves is never called. Remove that unused implementation and keep all result/non-invocation assertions. |
| Investigate, next priority | Nine cases across five UI files read implementation source: `ai-session-tab`, `github-app-card`, `preview-liveness`, `project-git-mutation`, and `terminal-lifecycle`. CSS declarations, function names, JSX counts and callback spelling can fail after harmless refactors while allowing broken behavior to pass. Replace only where the corresponding browser/component scenario is established. |
| Investigate | `project-git-mutation.test.ts`'s success check overlaps the browser request-count assertion in `e2e/workbench-editor.spec.ts`, but its failure/in-progress checks are not established by that browser case. Do not delete the entire file on the strength of the success overlap. |
| Investigate | GitHub form source checks include credential and repository authority claims; onboarding E2E covers only the unconfigured form. Preserve until behavior/security tests prove the configured flow. AI source checks include initial-start recovery and historical revision fencing; no deletion in this batch. |
| Simplify/consolidate, later | The 2,387-line Agent AI runtime file builds a fake Docker/JSON-RPC transport with many fault controls; the 2,019-line Web AI session file has separate fake-Agent, fake-database and real-database arrangements. Narrow fixture builders within each owning subsystem could reduce setup. Do not merge their boundary-specific assertions into a common mega-fixture. |
| Simplify/consolidate, next batch | The per-turn aggregate-bound test in `web/server/ai-sessions.test.ts` repeats the project/workspace/session/turn setup already in `historyFixture()`. Reuse that builder after confirming identity values are irrelevant; preserve the 34 output events and the 2 MiB/truncation assertions. The multibyte and many-turn aggregate cases exercise distinct limits and should remain. |
| Investigate | Agent artifact staging builds binary readback frames both in fake-engine tests and real Docker acceptance. Share only framing construction if it stays independent of production parsing. Keep malformed/incomplete frames and real helper execution. |
| Keep / investigate setup | Captured Codex fixtures occupy 853,339 bytes in 14 files (directory allocation about 932 KiB). Baseline fixture tests verify hashes/private launch authority; compatibility matrix tests exercise additive schemas, missing methods and cycles. They serve different purposes. Cache immutable reads locally before considering removal; do not regenerate evidence from production code. |

## Timing, flakiness and history

There are two explicit conditional skips, both requiring a dedicated rootless socket;
no explicit todo, unconditional skip, or retry configuration was found in the searched suite.
Baseline timer calls occur in 23 test files and Vitest mocking APIs in 36; those are search signals,
not deletion findings. Many `readFile` calls inspect persisted artifacts rather than source.

`harness-lifecycle.test.ts` polls every 10 ms with a 3-second deadline around a production
monitor that can back off to two seconds. `execution-manager.test.ts` also polls real time;
external-execution race tests use real processes and deadlines. Browser flows have
90–360-second budgets and observable-state polling. These are timing-sensitive candidates,
not proven current flakes. `preview-gateway-host/connector.test.ts` obtains then releases a
port before rebinding; investigate the port race if CI evidence points there.

History reviewed includes initial lifecycle commit `3d9d2dd`, AI workbench PRs #43/#50,
native harness #52, cleanup race #53 (`429a8b2`), and session-listing #65. PR #53 added
fixture quiescence before directory cleanup: preserve it. Large AI subsystem additions
contain unique credential, approval, finalization and restart fault cases, so blanket pruning
would be unsafe. Commit author labels do not reliably establish AI authorship; findings
are based on actual bodies and overlapping assertions, not inferred provenance.

## Protection and limits

No production behavior, acceptance workflow, security scenario, authorization scenario,
recovery scenario, persistence scenario, migration scenario or isolation scenario is removed.
No replacement framework or new fixtures are introduced. This batch removes duplicate or
tautological runtime cases and fixture numeric bookkeeping. It does not claim a measured
coverage percentage: meaningful protection is compared directly against retained assertions.
The browser suite is collected locally, not executed; existing CI does not run Playwright.
Real Docker acceptance runs on disposable CI infrastructure. No live DevSpace service, container, runtime socket or data directory is used.

## First-batch measurements and verification

Counts and lines include the review correction; timing and full-suite results below refer
to the initial cleanup commit `2f5bb35`. The correction retains the same case counts.

| Measure | Before | After |
| --- | ---: | ---: |
| Test files, all runners | 189 | 189 |
| Inventoried cases, including 11 E2E and 2 gated rootless cases | 3,382 | 3,379 |
| Vitest cases, including 2 gated rootless cases | 3,262 | 3,259 |
| Tooling / E2E cases | 109 / 11 | 109 / 11 |
| Named test-file physical lines | 42,209 | 42,136 |
| Focused cases, five changed files | 809 | 806 |
| Focused elapsed time, same JSON reporter | 37.90 s | 57.79 s |
| Full local Vitest elapsed | 327.57 s | ~319.73 s |
| Tooling test elapsed | 4.98 s | 5.16 s |

The revised batch removes **73 net test lines**. Three runtime
cases are removed; the fixed aggregate regression case is retained and simplified. The initial
focused run passes all 806 cases. Comparing its JSON assertion names with baseline proves
that all 690 transition pairs remain. The slower focused run demonstrates that these small
maintenance changes do not establish a speed gain. SQLite aggregate-bound cases dominate
that focused run (the largest single case varied from 8.07 s to 11.10 s).

Frozen-lockfile install, lint (including workspace validation), typecheck, build,
contracts/schema consistency, migration tests (10 cases), and migration drift checks pass.
Self-review confirms only five test files and audit/status documentation change. Typecheck
continues to compile the negative lifecycle type fixtures; independent security review is
not needed for this test-only batch. The full `pnpm test` rerun passes **3,257 Vitest + 109 tooling cases**, with the two
rootless cases skipped locally. Baseline passed 3,260 + 109 with the same skips. Final
runner counts match the inventory file by file. The before duration is Vitest's default
summary; the after duration is JSON `max(endTime) - startTime`, which excludes final reporter
teardown. Treat these single runs as approximate comparisons, not evidence of a speed gain.

Full rerun hotspots (sum of reported case durations, excluding imports/collection):

| File | Case execution |
| --- | ---: |
| `apps/agent/src/ai-session-runtime.test.ts` | 53.80 s |
| `apps/web/src/server/ai-sessions.test.ts` | 36.39 s |
| `apps/agent/src/managed-workspaces.test.ts` | 17.35 s |
| `apps/agent/src/harness-home.test.ts` | 14.24 s |
| `apps/web/src/server/agent-client.test.ts` | 12.25 s |

These five files use about 54% of 246.23 seconds of case execution. By comparison, the
1,190 remaining domain cases use 0.17 seconds. Prioritize verified fixture/setup and waiting
costs in the measured hotspots. Large case counts in cheap matrices are a poor optimization
signal.

Clean-clone verification uses `.github/workflows/ci.yml`; the real rootless acceptance gate
uses `.github/workflows/rootless-git-integration.yml`. Head-commit CI outcomes accompany the
PR delivery. The [baseline main CI run](https://github.com/Benflex1/DevSpace/actions/runs/38072582615)
passed and reported 253.77 seconds for Vitest on its separate hosted runner.

## Review correction — 2026-10-11

The aggregate fixture test now asserts the fixed object `{ lifecycles: 17, allowedEdges: 245,
orderedPairs: 690 }`. This detects accidental fixture shrinkage while keeping the 17 sets
of per-lifecycle numeric bookkeeping removed. The test count and all 690 behavioral pair
checks are unchanged. All 1,191 domain cases pass, as do domain typechecking, targeted
ESLint, repository text checks and `git diff --check`. Temporary edge and state shrink
mutations each fail the fixed aggregate assertion; both mutations were restored before
rerunning the domain suite (1.73 s). PR #66 verifies the corrected head through CI.

The absence of Playwright execution in CI is recorded separately as a **public-alpha
acceptance gap** in `docs/current-state.md`. Closing that delivery gap requires browser
execution and recorded results on disposable CI infrastructure; it is outside test deletion
and this correction.

After PR #66 is merged, prioritize behavioral replacements or justified removal of the nine
UI source-reading cases, then redundant setup in Agent AI runtime and Web AI session tests.
Measure runtime improvements and retain unique security, recovery, persistence and real
Docker coverage. Reuse existing fixtures; avoid new infrastructure or broad production refactors.


## Final planned batch — 2026-10-11

Baseline: merged PR #66, `a185e0e`. This review is limited to the five UI files named above
and `agent/ai-session-runtime.test.ts` / `web/server/ai-sessions.test.ts`; it is not another
repository-wide audit. No production code, dependencies, framework, or CI workflows change.

### All nine source-reading cases

| Case | Final decision and preserved protection |
| --- | --- |
| AI initial-start recovery | Replace source spelling with the existing React/Fake DOM harness: the recovery message and enabled retry button render, clicking sends the Create action with the workspace ID, disables retry until the response settles, and reloads the returned exact session ID. Existing coordinator tests retain duplicate-click, pending, stale-selection, wrong-returned-identity and failure/retry checks. |
| AI historical revision | Replace source spelling with a mounted stopped session under an older profile revision: persisted output renders, the historical-only message appears, no restart button appears, and no POST occurs. Agent/Web profile fencing and exact-session restart tests remain. |
| GitHub project form | Keep. Existing mounted form coverage handles reconnect-pending, not configured repository submission. Preserve opaque repository-ID submission and absence of browser credential/URL authority; existing field suggestion behavior stays. |
| Preview-only polling request | Keep. Poller behavior tests cover cadence, eligibility, visibility and non-overlap, but do not prove the Workbench requests previews without refreshing tasks. |
| Git mutation reconciliation | Keep. Browser success request-count coverage does not replace failure refresh or in-progress delayed reconciliation. Removing only the success fragment saves little and loses the fast local guard while browser CI is still pending. |
| Lost-terminal dialog integration | Keep. Pure dialog/state tests and browser dismissal cover portions, not complete callback integration, restart admission and terminal/tab pruning. Retain narrow request action/endpoint and pending-ref checks, plus the router refresh assertion moved from the old runtime source case. |
| Runtime action presentation | Replace function/JSX counts and spelling with static rendering of the real RuntimeControls component: exactly one action renders with enabled Start/Stop labels under authorization, unauthorized Stop is disabled, and an active Stop renders one disabled Stopping action. Existing runtime-control-state and runtime-restart tests retain authorization and fresh stop/start sequencing. |
| Recovery button styling | Keep. No equivalent browser assertion establishes relative Dismiss/Restart styling; introducing computed-style infrastructure would make this cleanup more complex. |
| Bounded terminal surface styling | Keep. Browser editor geometry assertions concern Monaco, not xterm bounds. Preserve the terminal flex/overflow declarations and absence of the old duplicate header until actual terminal layout acceptance covers them. |

Three cases change assertions, none are deleted or added. Six source-reading cases remain
intentionally; changing them further would require acceptance work or more test infrastructure.
The mounted AI checks add a small local fixture and reuse the existing DOM helper; the runtime
presentation check uses server rendering and adds no DOM setup. No browser execution is added.

### Agent and Web setup review

- Reuse `startedCodexFixture` / `startFixtureTurn` in four ordinary malformed/notification
  scenarios, with one optional private-observation callback. Custom launch, discovery,
  credential, restart, interaction and finalization fault arrangements remain separate.
- Remove identical success responders in favor of `createProtocolDocker`'s existing default.
  Custom response IDs, errors, delayed replies and withheld responses are unchanged.
- Add fixture teardown that closes the fake provider transport, then awaits runtime Stop
  before removing the temporary directory. This avoids waiting for a fake stream to close
  by the real one-second finalization deadline in ordinary protocol tests. Assertions occur
  before teardown. Dedicated automatic-finalization, provider-exit proof, cleanup refusal,
  lease-release failure, persistence retry and concurrent-finalization tests retain their
  original transports and waits. PR #53's cleanup quiescence remains.
- Remove `Unauthorized preserves the failed turn, marks reauthentication, and keeps durable
  auth`: the retained `Unauthorized automatically finalizes, preserves durable auth, and
  leaves reauthentication required` sends the same two native messages and asserts every
  removed protection (one failed turn, reauthentication refusal, durable auth readable,
  private text absent), plus stopped history and provider/cleanup inspections.
- Replace the duplicated real SQLite project/workspace/session/turn setup and unnecessary
  type cast in the per-turn output aggregate case with `historyFixture()`. The event loop
  is unchanged: canonical acceptance at sequence 1 and 33 output deltas at sequences 2–34,
  followed by the same 2 MiB bound and truncation assertions. The earlier audit's phrase
  "34 output events" counted acceptance; no event is removed. Multibyte, many-turn,
  contiguous suffix, legacy read normalization and migration checks remain separate.
- Keep fresh temporary roots and real SQLite databases per scenario. Sharing mutable runtime
  or migrated databases would compromise isolation. Keep meaningful `vi.fn` call/order
  assertions, bounded protocol waits, admission-race polling and long-turn liveness waits;
  replacing all clocks or collection with new synchronization machinery has poor value here.

No unique security, authorization, recovery, persistence, migration, isolation or protocol
case is removed. All native framing, malformed messages, private projection, approval/input,
restart generation, history bounds and outbox fault assertions remain. The only removed case
has the exact stronger retained counterpart above.

### Measurements and verification

The [final-batch TSV](test-suite-2026-10-11-final.tsv) records expanded cases and physical
lines for all seven reviewed files. First-batch inventory remains historical and unchanged.
Counts outside these files use PR #66's inventory; this batch does not recollect browser
or gated rootless tests. Physical lines include blanks and comments.

| Measure | Before | After |
| --- | ---: | ---: |
| Test files, all runners | 189 | 189 |
| Inventoried cases, including E2E and gated rootless | 3,379 | 3,378 |
| Vitest cases, including 2 gated rootless | 3,259 | 3,258 |
| Tooling / E2E cases | 109 / 11 | 109 / 11 |
| Named test-file physical lines | 42,136 | 42,079 |
| Seven reviewed files: cases | 223 | 222 |
| Seven reviewed files: lines | 4,862 | 4,805 |
| Agent runtime: cases / lines | 87 / 2,387 | 86 / 2,311 |
| Web AI orchestration: cases / lines | 90 / 2,011 | 90 / 1,969 |
| AI tab: cases / lines | 3 / 39 | 3 / 88 |
| Terminal lifecycle: cases / lines | 28 / 176 | 28 / 188 |
| UI source-reading cases | 9 | 6 |
| Focused elapsed, identical JSON reporter | 99.47 s | 76.64 s |
| Agent runtime case execution | 61.55 s | 38.67 s |
| Web AI orchestration case execution | 33.88 s | 33.99 s |

Net reduction: **57 test-code lines and one redundant case**. Agent/Web setup saves 118
lines; behavioral UI replacements add 61 lines. Meaningful mounted recovery assertions cost
a few tens of milliseconds rather than introducing browser startup or another framework.
Timing runs use the same seven paths, working directory, Node/pnpm versions, existing
Vitest configuration and `--reporter=json --outputFile=...`. JSON elapsed is
`max(testResults.endTime) - startTime`, excluding final reporter teardown. These single
runs are approximate, not a benchmark; the improvement comes from ordinary fake-stream
teardown, while SQLite timing noise is reported separately. Node is v24.21.0 locally;
hosted clean-clone CI uses the workflow's pinned v24.18.0. pnpm is 11.13.0 in both.

Final focused run passes all 222 cases. Comparing collected names against baseline shows
only the duplicate Unauthorized case removed; all 90 Web AI orchestration cases remain.
The AI initial-retry replacement also asserts that the mounted button is disabled while
Create is pending. Final test-file typechecking passes.

Frozen-lockfile install, workspace validation, lint (including architecture/text checks),
full typecheck, build, toolchain consistency, raw gateway deployment checks, contracts/schema
checks, migration tests (10 cases), and migration drift checks pass locally. Full `pnpm test`
passes **3,256 Vitest + 109 tooling cases**, with the same two rootless cases skipped locally
(345.17 s Vitest / 5.12 s tooling). This full run overlapped other local checks and is not a
controlled comparison with the first batch. A pre-existing untracked session transcript with
trailing whitespace was temporarily moved outside the checkout for lint, then restored;
it is excluded from this PR.

Docker/Compose is unavailable locally: the materialization check reports that requirement;
rendered Compose checks, Caddy/Coolify smoke tests, native helper reproducibility and real
rootless acceptance are delegated to the unchanged GitHub workflows. Head-commit CI results
and links accompany the draft PR delivery. Playwright is neither run nor added to CI here.

Self-review confirms the diff contains four test files and audit/status documentation only.
No production code or workflow changes, new framework, shared mega-fixture, or unique
security/authority scenario removal warrants an independent boundary review for this batch.

### Audit closure

Close this audit after this second and final planned batch. Further broad cleanup does not
have sufficient demonstrated value to delay public-alpha development. Retained source checks
can be retired opportunistically when product work establishes equivalent component/browser
coverage. Docker acceptance and Playwright CI acceptance remain roadmap delivery work, not
reasons to start a third test-cleanup batch. Playwright CI execution is explicitly outside this PR.
