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
| Simplify/consolidate, first batch | Lifecycle fixture numeric totals duplicate values derivable from the independent rows and state Cartesian products. Remove numeric bookkeeping, retaining the rows, all behavioral cases, terminal-state checks, duplicate detection, endpoint membership, prohibition of self edges, and the check that all 17 lifecycle fixtures are present. |
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

| Measure | Before | After |
| --- | ---: | ---: |
| Test files, all runners | 189 | 189 |
| Inventoried cases, including 11 E2E and 2 gated rootless cases | 3,382 | 3,379 |
| Vitest cases, including 2 gated rootless cases | 3,262 | 3,259 |
| Tooling / E2E cases | 109 / 11 | 109 / 11 |
| Named test-file physical lines | 42,209 | 42,132 |
| Focused cases, five changed files | 809 | 806 |
| Focused elapsed time, same JSON reporter | 37.90 s | 57.79 s |
| Full local Vitest elapsed | 327.57 s | ~319.73 s |
| Tooling test elapsed | 4.98 s | 5.16 s |

The diff removes 80 test lines and adds 3: **77 net lines removed**. Three runtime
cases are removed; the fixture cardinality case is retained and simplified. The final
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
