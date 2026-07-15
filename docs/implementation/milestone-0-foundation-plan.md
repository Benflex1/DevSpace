# Milestone 0 executable foundation implementation plan

## Purpose

This plan turns the current documentation-only scaffold into a real, executable, testable pnpm/TypeScript foundation. It is limited to Milestone 0: package boundaries, contracts, schemas, immutable data definitions, migrations, pure domain rules, pure security helpers, fixtures, and CI checks.

It does not implement any web or agent product behavior. In particular, it does not discover repositories, mutate Git, control Docker, execute processes, create terminals, register previews, administer Cloudflare or Caddy, or start AI sessions.

## Inputs inspected

The initial audit covered the repository scaffold, documentation, specifications, accepted ADRs, package ownership notes, configuration, schemas, and placeholder tooling that existed when this plan was written. M0-F01 subsequently restored the orchestration inputs and closed the representation blockers recorded below. The concrete model and chat recommendations in this revision follow `docs/ai-development-workflow.md`.

## Current scaffold assessment

- Only the root is a pnpm importer. `apps/*` and `packages/*` contain READMEs but no manifests, source roots, tests, or build outputs.
- The root scripts are placeholder checks: lint checks whitespace, typecheck parses JSON, build checks file presence, three different contract/schema/migration commands share placeholder scripts, and the only tests inspect two JSON properties.
- `tsconfig.base.json` has useful strictness flags but no package project references, emit policy, library/type policy, or separate build/test configurations.
- `schemas/project-options-v1.schema.json` is hand-authored and stricter than a JSON parse, but it does not cover the complete prose specification or cross-field invariants.
- No runtime validators, generated contract schemas, canonicalization implementation, state-machine functions, Drizzle definitions, SQL migrations, temporary-database tests, CI workflow, or package dependency graph exists.

## Sequencing decisions

1. Establish the real workspace and shared quality tooling before adding domain code. Use pnpm recursive execution and TypeScript project references; do not add a task orchestrator in Milestone 0.
2. Make each production package build independently, with dependency direction enforced by manifests and lint rules. Create `packages/testkit` only in M0-F04, when the test foundation consumes it.
3. Close specification gaps immediately before implementing the affected package. Documentation-only closure tasks are deliberate gates, not invitations to replace accepted ADRs.
4. Use one executable runtime-schema representation as the source for TypeScript inference and committed JSON Schema artifacts. Generated files are drift-checked, never hand-edited.
5. Implement pure leaf foundations first (`domain` and `security`), then Project Options and contracts, then database schema/migrations.
6. Treat migration SQL as a committed release artifact. Test the same migration path the web application will eventually invoke; do not give the agent database access.
7. Replace each placeholder command only when its real successor exists. Keep a narrowly named repository hygiene check if desired, but do not continue presenting scaffold/file-presence checks as lint, build, contracts, schemas, or migrations.
8. Finish with one Linux clean-clone CI job whose command sequence exactly matches `AGENTS.md`; package-specific jobs may be added only as diagnostics, not as substitutes. Preserve table-driven Windows drive, separator, and UNC hostile-path fixtures in that Linux job.

## Model escalation and grouped-chat strategy

Use Luna XHigh for clearly scoped implementation work. Use Sol Medium for architecture, security, protocol, lifecycle, and database work. If one focused Sol Medium attempt plus a well-targeted correction fails, escalate that task to Sol High or Max. Never recommend Sol Ultra.

Numbered tasks are review boundaries, not a requirement for one fresh chat each. The intended groups are M0-F02 through M0-F04, M0-F05 through M0-F06, M0-F07 through M0-F08, M0-F09 through M0-F10, M0-F11 through M0-F13, and M0-F14 as final integration. Keep a group in one chat while context remains accurate and checks isolate each numbered slice; rotate early if the workflow's stale-context conditions apply.

## Intended package graph and ownership

```text
apps/web   -> contracts, domain, project-options, database, security (types/build only in M0)
apps/agent -> contracts, domain, project-options, security (types/build only in M0)

packages/domain          -> no internal production dependency
packages/security        -> domain (only the extracted branch-shorthand primitive in M0-F09;
                            its existing public security API remains authoritative to callers)
packages/project-options -> security (only shared pure validators)
packages/contracts       -> domain; no project-options dependency in Milestone 0
packages/database        -> domain constants at schema-generation time; no app or agent dependency

packages/testkit         -> deferred until M0-F04, then dev-only fixture utilities
packages/gateway-caddy   -> deferred until the preview milestone; not a Milestone 0 workspace package
```

Avoid a `shared`/`utils` package. The schema library and JSON Schema validator may be common external dependencies without creating a new internal common package. `database` owns schema/migrations, not web repositories or application transactions; those belong to `apps/web` when their milestone arrives. `project-options` owns canonical configuration and hashing, but actual runtime-plan compilation remains Milestone 1.

## Dependency-ordered tasks

### M0-F01 — Close foundation-wide representation and specification decisions

**Exact goal:** Record the minimum implementation decisions shared by multiple packages and close the Project Options, agent protocol, lifecycle, database, and orchestration blockers identified by this plan.

**Affected:** ADR 013, the four foundation specifications, this plan, `docs/current-state.md`, and `docs/orchestration/current-task.md`.

**Dependencies:** None.

**Implementation details:** Record Node.js 24 LTS, pnpm 11, ESM, Zod runtime schemas, generated draft 2020-12 artifacts, UUIDv7 IDs, millisecond UTC timestamps, RFC 8785/JCS, versioned SHA-256 hashes, REST-style HTTP over the Unix socket, and per-boot cursor recovery. Separate project metadata from immutable runtime configuration, complete workspace container configuration, define web-owned operations plus the agent's narrow execution journal, and reserve sequence zero for snapshot/cursor boundaries. Complete the owning specifications without changing implementation or generated artifacts.

**Explicit non-goals:** No manifests, dependencies, generated schemas, validators, or product code.

**Acceptance criteria:** All named decisions have one authoritative answer; accepted ADRs remain unchanged unless explicitly superseded; the model policy exists and gives concrete task-to-model guidance; downstream tasks no longer need to guess these representations.

**Required automated checks:** Existing checks that still apply; `git diff --check`; link/path check if available.

**Likely risks or decisions:** Duplicating specification detail in the ADR, treating generated JSON Schema as a second authority, or leaving a cross-package representation implicit.

**Recommended model:** Sol Medium.

**Next chat:** Completed on 2026-07-14. Start M0-F02 through M0-F04 as the next grouped implementation chat.

### M0-F02 — Create the real pnpm workspace and package manifests

**Exact goal:** Turn every Milestone 0 app and production-package directory into a real private or publishable workspace importer with explicit names, entry points, dependency direction, and package scripts while preserving zero product behavior. Defer `packages/testkit` to M0-F04 and `packages/gateway-caddy` to the preview milestone.

**Affected:** Root `package.json`, `pnpm-workspace.yaml`, lockfile, `apps/*`, `packages/*`, package READMEs, `.npmrc`/version pin files if selected, `docs/current-state.md`.

**Dependencies:** M0-F01 for runtime versions and module policy.

**Implementation details:** Pin the exact pnpm 11 `packageManager` value and Node.js 24 LTS range; use `workspace:*` for internal dependencies; add manifests and empty typed entry modules where a buildable package needs one; mark apps/private tooling as private; define `exports`, `types`, and `files` deliberately. Remove the ineffective `tooling/*` workspace glob unless real tooling packages are intentionally created. Use pnpm recursive scripts rather than adding Turbo/Nx. Add an import-direction rule or dependency-graph test that prohibits app dependencies from packages, a `contracts -> project-options` edge, and runtime imports from the later `testkit` package.

**Explicit non-goals:** No server bootstrap, routes, sockets, filesystem access, runtime adapters, UI, or database access.

**Acceptance criteria:** `pnpm install --frozen-lockfile` recognizes all intended importers; every workspace has an intentional manifest; recursive command selection reaches all relevant packages; package graph matches the ownership section above.

**Required automated checks:** `pnpm install --frozen-lockfile`; `pnpm -r list --depth -1`; temporary package-graph assertion; `git diff --check`.

**Likely risks or decisions:** Accidental circular dependencies; publishing metadata for packages meant to remain private; native dependencies added too early.

**Recommended model:** Luna XHigh.

**Next chat:** Begin the grouped M0-F02 through M0-F04 implementation chat.

### M0-F03 — Add shared TypeScript build and lint configuration

**Exact goal:** Replace JSON parsing and whitespace-only “typecheck/lint” with real strict TypeScript compilation, package builds, and semantic linting.

**Affected:** Root/shared TypeScript configs, package `tsconfig` files, ESLint configuration, root/package scripts, package source stubs, `tooling/check-text.mjs`, `docs/current-state.md`.

**Dependencies:** M0-F02.

**Implementation details:** Keep the existing strict flags; add explicit `lib`, Node types policy, declaration/source-map settings, root/out directories, incremental build info locations, and separate no-emit typecheck versus emitting build configs. Use project references or dependency-ordered `tsc -b`. Configure ESLint for TypeScript with type-aware rules where they provide value, import-boundary enforcement, and ignored generated/build paths. Preserve final-newline/trailing-whitespace validation as a clearly named hygiene rule or integrate it into formatting; it must not be the whole lint command.

**Explicit non-goals:** No framework selection for either app, bundler, web server, agent server, or product logic.

**Acceptance criteria:** An intentional type error fails `pnpm typecheck`; an intentional lint violation fails `pnpm lint`; `pnpm build` emits declarations/JavaScript for buildable packages and succeeds from clean output; package references do not escape ownership boundaries.

**Required automated checks:** `pnpm lint`; `pnpm typecheck`; `pnpm build`; `git diff --check`.

**Likely risks or decisions:** NodeNext extension rules; lint/typecheck duplication; generated files entering lint; shared config creating circular workspace dependencies.

**Recommended model:** Luna XHigh.

**Next chat:** Continue the M0-F02 through M0-F04 grouped chat if the M0-F02 slice is accepted and context remains accurate.

### M0-F04 — Establish the unit-test and fixture harness

**Exact goal:** Replace `node --test` scaffold assertions with a real TypeScript unit-test setup and reusable, side-effect-free fixture utilities.

**Affected:** Test runner config, root/package scripts, `packages/testkit`, `tooling/tests`, coverage configuration, `docs/current-state.md`.

**Dependencies:** M0-F02 and M0-F03.

**Implementation details:** Select the test runner within this task (Vitest is the default recommendation); give each package colocated unit tests and shared root defaults; make CI mode deterministic and non-watch; define temporary-directory helpers with cleanup and JSON fixture loading in `testkit`. Add coverage collection/reporting but defer hard global thresholds until meaningful code exists. Delete or rename `tooling/tests/scaffold.test.mjs` once equivalent real assertions exist.

**Explicit non-goals:** No fake agent, temporary Git repositories, Docker fixtures, browser tests, or app integration tests; those belong to later milestones.

**Acceptance criteria:** TypeScript tests run in all participating packages; a failing assertion returns nonzero; test discovery cannot silently pass with zero tests; temporary resources are isolated and cleaned.

**Required automated checks:** `pnpm test`; `pnpm typecheck`; one test-runner self-test during the slice; `git diff --check`.

**Likely risks or decisions:** ESM/test-runner resolution differences; testkit leaking into production bundles; Windows/Linux temp-path differences.

**Recommended model:** Luna XHigh.

**Next chat:** Complete the M0-F02 through M0-F04 grouped chat, preserving a separate review/check boundary for M0-F04.

### M0-F05 — Implement pure domain lifecycle state machines

**Exact goal:** Represent every sufficiently specified lifecycle as typed states and explicit pure transition functions, with exhaustive positive and negative transition tests.

**Affected:** `packages/domain`, `docs/specs/lifecycle-states.md` only if gaps must be closed, fixtures, `docs/current-state.md`.

**Dependencies:** M0-F03, M0-F04, and the relevant representation choices from M0-F01.

**Implementation details:** Use readonly state/transition tables and a small typed transition API returning a domain error/result rather than unconstrained string assignment. Cover project, configuration revision, workspace desired/observed, runtime stack, process, terminal, preview, AI session, and task run only after each graph is complete. Encode the isolated-workspace dirty gate as an invariant with an explicit dirty-action input; keep persistence and side effects outside the package. Add compile-time exhaustiveness checks and table-driven tests for every allowed edge, every disallowed pair, terminal states, and contextual guards.

**Explicit non-goals:** No orchestrator, reconciliation, timers, processes, Docker, Git, terminals, previews, AI, or database writes.

**Acceptance criteria:** No lifecycle can transition through a generic string setter; tests enumerate all states and prove graph/spec parity; invalid transitions produce stable typed errors; dirty archive/remove policy is tested without filesystem access.

**Required automated checks:** Package unit tests; `pnpm test`; `pnpm typecheck`; `pnpm build`.

**Likely risks or decisions:** State tables drifting from the now-complete specification, confusing desired with observed state, or treating `lost` as an implicit synonym for stopped/absent.

**Recommended model:** Sol Medium.

**Next chat:** Begin the grouped M0-F05 through M0-F06 domain/security chat.

### M0-F06 — Implement pure security validation primitives

**Exact goal:** Provide Milestone 0 pure helpers for untrusted relative paths, canonical managed-root containment inputs, Git-ref lexical validation boundaries, hostname labels/patterns, and approved preview-base composition.

**Affected:** `packages/security`, security fixtures/tests, `docs/current-state.md`; threat model/spec clarification only if required.

**Dependencies:** M0-F03 and M0-F04.

**Implementation details:** Separate lexical validation from filesystem canonicalization so callers cannot mistake string normalization for symlink-safe authorization. Reject NULs, absolute paths, traversal, platform separators where disallowed, ambiguous drive/UNC forms, empty segments, and normalization surprises. For hostnames, enforce lower-case ASCII label/length rules, allowed placeholders, exactly one generated label where specified, approved base IDs supplied by trusted configuration, and final FQDN limits. Use platform-independent table tests including Windows and POSIX cases. Expose typed errors and branded validated values only after successful validation.

**Explicit non-goals:** No filesystem reads, realpath/open-handle logic, repository discovery, import-root traversal, Git invocation/ref resolution, DNS, Caddy, Cloudflare, or route registration. Redaction and runtime policy may be later Milestone 0 slices only if separately specified.

**Acceptance criteria:** Traversal/absolute/UNC/drive/NUL and malicious hostname-pattern fixtures fail; valid relative Dockerfile/context/instructions/working-directory forms succeed under their distinct policies; APIs clearly state that symlink containment must be revalidated by the future agent.

**Required automated checks:** Package unit tests in the initial Linux CI, including table-driven Windows drive, separator, and UNC hostile-path fixtures; `pnpm test`; `pnpm lint`; `pnpm typecheck`.

**Likely risks or decisions:** Over-generalizing one path validator across semantically different fields; Unicode IDN policy; accidentally implying TOCTOU safety from a pure helper.

**Recommended model:** Sol Medium.

**Next chat:** Continue the M0-F05 through M0-F06 grouped chat after the lifecycle slice is accepted.

### M0-F07 — Reconcile and implement Project Options v1 runtime schema

**Exact goal:** Implement the reconciled Project Options v1 specification as the executable strict parser and sole source for inferred types and generated JSON Schema.

**Affected:** `docs/specs/project-options-v1.md`, `packages/project-options`, `schemas/project-options-v1.schema.json`, root schema scripts, fixtures, `docs/current-state.md`.

**Dependencies:** M0-F01, M0-F03, M0-F04, and M0-F06.

**Implementation details:** Implement the runtime-revision fields, defaults, strict nested objects, top-level workspace-scoped named volumes, development-environment variables/ports/mounts, structured service startup overrides, discriminated environment-binding unions, collection ordering, bounded scalars, unique stable keys, task/service/preview cross-references, workspace and service declared-port matching, secret-ID-only persistence, placeholder allowlists, and forbidden capability rejection already defined by the specification. The task fields `interactive`, `longRunning`, `timeoutSeconds`, and `concurrencyPolicy` are independent in v1: all structurally valid combinations are supported and no additional task combination matrix is validated. Project General metadata remains authoritative on `projects` and is not part of this schema. Parse unknown input into a typed v1 value with structured path-aware issues. Generate the committed draft 2020-12 artifact deterministically from the runtime source, and make `schema:check` regenerate to a temp location and byte-compare. Keep version dispatch explicit so v2 can coexist later.

**Explicit non-goals:** No UI, detection/import, database revision workflow, secret storage, Dockerfile inspection, package installation, runtime plan compilation, container policy validation, or activation.

**Acceptance criteria:** The example and every valid fixture parse; unknown keys and all invalid/cross-reference fixtures fail with stable issue paths/codes; generated schema validates the same portable constraints as runtime parsing; runtime-only refinements are documented and fixture-tested; hand edits to the generated schema fail `schema:check`.

**Required automated checks:** Project Options unit/fixture tests; `pnpm schema:check`; `pnpm test`; `pnpm typecheck`; `pnpm build`.

**Likely risks or decisions:** JSON Schema cannot encode every refinement; applying defaults during parsing can change hashes; schema-library output churn; mistakenly implementing Milestone 1 runtime-plan compilation.

**Recommended model:** Luna XHigh.

**Next chat:** Begin the grouped M0-F07 through M0-F08 Project Options chat.

### M0-F08 — Add Project Options canonicalization, hashing, and compatibility fixtures

**Exact goal:** Produce a deterministic canonical Project Options v1 representation and revision hash from already validated data, with fixtures that prove stability.

**Affected:** `packages/project-options`, canonical/invalid fixtures, root schema checks, `docs/current-state.md`.

**Dependencies:** M0-F07 and the canonicalization decision in M0-F01.

**Implementation details:** Apply only the documented normalization: materialize explicit defaults, sort collections declared unordered, and require already-canonical scalar forms without trimming, Unicode normalization, URL rewriting, or path rewriting. Preserve order for semantically ordered arrays such as setup steps and service startup arrays. Serialize with RFC 8785/JCS, hash the specified domain-separated UTF-8 input with SHA-256, and expose the `sha256-jcs-v1:<lowercase hex>` representation. Project metadata and workspace display names are separate compiler inputs and never revision-hash inputs. Add golden fixtures and tests for key insertion order, equivalent defaulted inputs, array-order sensitivity, Unicode, numeric bounds, and changed semantic values.

**Explicit non-goals:** No revision persistence/activation, mutable drafts, runtime-plan hashes, secret material, or import/export UI.

**Acceptance criteria:** Semantically equivalent accepted inputs produce identical canonical bytes/hash; meaningful differences produce a different hash; canonical output reparses; golden hashes are stable across supported Node versions and operating systems.

**Required automated checks:** Golden fixture tests; `pnpm schema:check`; `pnpm test`; `pnpm typecheck`; `pnpm build`.

**Likely risks or decisions:** Default insertion changing user intent; order semantics for task/service/variable collections; golden churn from implementation-defined serialization.

**Recommended model:** Luna XHigh.

**Next chat:** Same chat as M0-F07 if the schema review remains focused.

### M0-F09 — Define versioned agent protocol primitives, responses, and errors

**Exact goal:** Establish the v1 HTTP-over-Unix-socket wire contract for request metadata, success responses, typed errors, IDs, timestamps, resource references, idempotency data, and protocol/version negotiation.

**Affected:** `docs/specs/agent-api-v1.md`, `packages/contracts`, the narrow branch-validator ownership extraction in `packages/domain` and delegation in `packages/security`, contract JSON Schema outputs and fixtures, `docs/current-state.md`.

**Dependencies:** M0-F01, M0-F03, M0-F04, M0-F05, and M0-F06. `packages/contracts` does not depend on `packages/project-options` or `packages/security` in Milestone 0.

**Implementation details:** Implement the corrected `agent-api-v1.md` F09 surface: exactly 29 unique REST-style HTTP/1.1/WebSocket-upgrade routes under `/v1`, comprising 19 mutations, nine ordinary non-mutating HTTP operations, and one non-mutating terminal upgrade. Do not introduce JSON-RPC. Define the specification's strict request and response schemas per operation, 23-code executable error union with per-code closed details/literal retryability, exhaustive route-specific error unions/statuses, the sole Web-created operation-ID header, private-journal replay/mismatch boundary, fixed capability metadata, and terminal binary framing contract. Mutation success is only `{ operationId }` and never duplicates Web-owned operation lifecycle. Configuration validation/registration transports only the versioned canonical Project Options document and revision hash; do not define or transport a runtime plan. Extract the existing branch-shorthand grammar/reasons into `@devspace/domain`; consume it from contracts and make `@devspace/security` delegate while preserving every F06 public result, brand, error code, and detail. Add security's exact `workspace:*` domain dependency and narrowly update graph enforcement for that one accepted edge; do not permit contracts to depend on security. Forbid unknown executable/runtime locator fields structurally and with negative fixtures. Generate named/versioned JSON Schemas and create one registry mapping the stable operation names/routes to request, response, and documented error validators. Exclude reconciliation, the two F10-owned snapshot/event endpoints, F10 errors, and every event/cursor schema.

**Explicit non-goals:** No Unix socket server/client, HTTP framework, authentication, handler, idempotency store, browser API, agent operation, or runtime inspection.

**Acceptance criteria:** All 29 F09 operations have their specified named request/success/error types, exact method/path/status metadata, and exhaustive route-specific error unions; exactly 19 mutations require only a caller-supplied operation ID; runtime-plan, public request-hash, second idempotency-key, extra terminal authorization-token, keyed AI-profile, reconciliation, and F10 error concepts remain absent; mandatory endpoint support is not capability-negotiated; domain/security/contracts branch validation has one behavior-preserving authority; malformed metadata and prohibited fields fail; protocol-version mismatch and terminal-frame/concurrency boundaries have fixtures; generated artifacts are deterministic and drift-checked.

**Required automated checks:** Contract unit/fixture tests; initial `pnpm contracts:check`; `pnpm typecheck`; `pnpm build`.

**Likely risks or decisions:** Drifting from the exact endpoint/error registries, treating durable acceptance as resource completion, duplicating Web operation lifecycle, copying rather than extracting branch validation, weakening closed nested objects, duplicating Project Options parsing/hashing, reintroducing undefined runtime-plan fields, or leaking deferred reconciliation/F10 fields into F09.

**Recommended model:** Sol Medium.

**Next chat:** After independent acceptance of the completed wire specification, implement M0-F09
without beginning M0-F10; retain a clean review boundary before event/cursor work.

### M0-F10 — Define versioned events, cursors, and contract compatibility checks

**Exact goal:** Complete the v1 event envelope and every required event payload, then fixture-test request/response/error/event compatibility as committed public artifacts.

**Affected:** `docs/specs/agent-api-v1.md`, `packages/contracts`, event fixtures and generated schemas, `packages/testkit`, `docs/current-state.md`.

**Dependencies:** M0-F09 and M0-F05.

**Implementation details:** Model events as a discriminated union on `type`, with the resource type and payload constrained together. Specify optional versus required `operationId`, per-boot event sequences beginning at one, cursor grammar that additionally permits the zero boundary, reconnect behavior across agent boots, event ordering guarantees, redacted error/progress payloads, and snapshot/event boundary behavior. Cover a pre-event snapshot cursor and replay from zero while rejecting event sequence zero. Store valid and one-purpose-invalid fixtures for every event. Make `contracts:check` regenerate schemas, validate fixtures, assert registry completeness, and detect removal/change of committed v1 artifacts without an explicit versioning action.

**Explicit non-goals:** No event producer/consumer, stream, persistence, WebSocket frames, terminal bytes, snapshot implementation, or reconciliation.

**Acceptance criteria:** Every required event type has a strict payload; unknown events/fields and resource-payload mismatches fail; cursors round-trip; terminal data cannot enter JSON domain events; the compatibility check fails on accidental v1 artifact drift.

**Required automated checks:** `pnpm contracts:check`; `pnpm test`; `pnpm typecheck`; `pnpm build`.

**Likely risks or decisions:** Implementing cursors as durable cross-boot offsets, failing to preserve the snapshot `throughCursor` boundary, or freezing later-milestone payload details before their task specifies them.

**Recommended model:** Sol Medium.

**Next chat:** Same chat as M0-F09.

### M0-F11 — Reconcile and implement the SQLite/Drizzle schema

**Exact goal:** Translate the accepted database v1 model into typed Drizzle SQLite table/index/constraint definitions without adding repositories or runtime writers.

**Affected:** `docs/specs/database-v1.md`, `packages/database`, schema tests, `docs/current-state.md`.

**Dependencies:** M0-F01, M0-F03, M0-F04, M0-F05, and Project Options/contract representations where stored values refer to them.

**Implementation details:** Implement the accepted UUIDv7/text, timestamp/text, enum, JSON-validation, row-version, nullable-pointer, and creation-order decisions. Keep project name, slug, repository URL, default branch, and automatic fetch policy authoritative on `projects`; keep workspace display name on `workspaces`; configuration JSON contains runtime configuration only. Define all listed tables, foreign keys, unique and partial indexes, checks, nullability, defaults, and migration metadata. Enable foreign keys in every test connection. Enforce at most one active revision and non-removed primary workspace with partial indexes; leave eventual exactly-one behavior and optimistic General Options updates to the specified future web transactions. Export schema metadata only; do not export CRUD repositories.

**Explicit non-goals:** No web persistence service, database singleton, API handler, activation transaction, reconciliation write, seed data, runtime operation, or agent database access.

**Acceptance criteria:** Drizzle definitions cover every decided v1 column/index/foreign key/check; schema tests inspect SQLite metadata and prove critical constraints; no package gives `apps/agent` a database dependency; stored enum values match domain definitions.

**Required automated checks:** Database schema unit tests; `pnpm test`; `pnpm typecheck`; `pnpm build`; schema generation drift check if separate from migration checks.

**Likely risks or decisions:** Drizzle support for partial indexes/checks; circular references; SQLite’s inability to enforce cross-row “exactly one”; storing sensitive paths/log metadata while preserving web-only writes.

**Recommended model:** Sol Medium.

**Next chat:** Begin the grouped M0-F11 through M0-F13 database chat.

### M0-F12 — Generate and commit forward-only migration infrastructure

**Exact goal:** Create the initial reproducible SQL migration set and migration metadata/configuration from the reviewed Drizzle schema.

**Affected:** `packages/database` Drizzle config, migration SQL/journal/snapshots, package/root scripts, migration documentation, `docs/current-state.md`.

**Dependencies:** M0-F11.

**Implementation details:** Keep Drizzle generation tooling in development dependencies and committed SQL as the deployable artifact. Define deterministic migration naming, review rules, schema-version metadata, newer-schema refusal contract, and a narrow migrator entry point intended for the future web startup only. Separate “generate” (may modify files) from “check” (must be read-only and fail on drift). Do not depend on a globally installed CLI. Document backup-before-destructive-migration as a future web deployment responsibility; the initial migration is non-destructive.

**Explicit non-goals:** No production database path, startup integration, backup implementation, downgrade/rollback, live data backfill, repository layer, or agent migration access.

**Acceptance criteria:** A clean install can generate/verify migrations with workspace-local tools; committed SQL creates the reviewed schema; migration order and metadata are deterministic; invoking the migrator against a newer unsupported version fails safely.

**Required automated checks:** Migration generation drift check; package tests; `pnpm typecheck`; `pnpm build`.

**Likely risks or decisions:** Native SQLite driver portability; Drizzle snapshot churn; a check command accidentally rewriting committed artifacts; defining the previous-release baseline before one exists.

**Recommended model:** Sol Medium.

**Next chat:** Same chat as M0-F11.

### M0-F13 — Add empty and upgrade-path temporary database migration tests

**Exact goal:** Make `pnpm db:migrate:test` prove both clean creation and forward upgrade behavior using isolated temporary SQLite databases.

**Affected:** `packages/database` migration tests/fixtures, `packages/testkit` temp helpers, root/package scripts, CI config later consumed by M0-F14, `docs/current-state.md`.

**Dependencies:** M0-F12 and M0-F04.

**Implementation details:** Scenario A creates a brand-new temporary database, runs all migrations, verifies migration metadata, foreign keys, tables, indexes, checks, and representative constraint failures. Scenario B applies the previous schema prefix or committed previous-release fixture, inserts representative valid rows, applies only later migrations, and verifies preservation plus final shape. For the initial release, explicitly define the “previously migrated” case as rerunning the migrator against a database already at the current migration level; when migration 0002 is added, require a real 0001-to-0002 data-preservation fixture. Include rejection of a synthetic newer schema version. Use a real SQLite database file, not a mocked driver or in-memory abstraction that bypasses file migration behavior.

**Explicit non-goals:** No production data, destructive migration, backup/restore system, concurrency/load testing, web repositories, or agent integration.

**Acceptance criteria:** Tests use unique temp files and clean them; empty, already-current, forward-prefix upgrade, and newer-version rejection cases are explicit; foreign keys are enabled; failures return nonzero and identify the migration/scenario.

**Required automated checks:** `pnpm db:migrate:test`; database package tests; `pnpm test`; run in the initial Linux CI. Cross-platform path behavior remains covered by platform-independent fixtures rather than a Windows CI job.

**Likely risks or decisions:** Native driver installation in frozen clean clones; false confidence from an already-current test before migration 0002; migration journal paths depending on the working directory.

**Recommended model:** Sol Medium.

**Next chat:** Same chat as M0-F12.

### M0-F14 — Wire the clean-clone CI contract and retire placeholders

**Exact goal:** Make the documented definition of done the actual local and CI contract, with no placeholder command masquerading as a real check.

**Affected:** Root/package scripts, CI workflow, obsolete `tooling/check-*.mjs` and scaffold tests, generated-artifact checks, READMEs, `docs/current-state.md`, `docs/orchestration/current-task.md`.

**Dependencies:** M0-F02 through M0-F13.

**Implementation details:** Configure one initial Linux CI job from a clean checkout with the pinned Node/pnpm versions and pnpm cache, then run exactly: `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm test`, `pnpm typecheck`, `pnpm build`, `pnpm contracts:check`, `pnpm schema:check`, and `pnpm db:migrate:test`. Ensure checks are non-interactive and read-only except build/temp outputs. Delete `check-json.mjs`, `check-scaffold.mjs`, and scaffold tests when their real successors cover them; keep `check-text.mjs` only under an honest hygiene name if still useful. Add a generated-artifact cleanliness assertion using `git diff --exit-code` in CI where generation checks cannot compare in memory/temp storage. Keep Windows drive, separator, and UNC hostile-path cases in table-driven fixtures executed on Linux; a Windows CI job is deferred until platform-specific runtime behavior exists.

**Explicit non-goals:** No deployment, container build, service startup, end-to-end browser test, runtime smoke test, Git mutation from product code, auto-merge, or later-milestone implementation.

**Acceptance criteria:** Every documented command invokes its real subsystem and can fail for a relevant defect; a clean clone passes in order; generated outputs do not dirty the checkout; package README/current-state claims match reality; all placeholders are removed or accurately renamed.

**Required automated checks:** The complete eight-command clean-clone sequence; `git diff --check`; CI workflow validation; `git status --short` after checks.

**Likely risks or decisions:** Local/CI Node drift; generated schemas or migrations changing line endings; root scripts skipping a workspace with no matching script; overloading one CI job without useful diagnostics.

**Recommended model:** Luna XHigh for implementation; Sol Medium for the independent architecture/scope review.

**Next chat:** Use one focused M0-F14 integration chat after M0-F11 through M0-F13 are accepted.

## Placeholder replacement matrix

| Current command | Current behavior | Real successor | Removal point |
| --- | --- | --- | --- |
| `lint` | newline/trailing whitespace only | ESLint over typed sources plus optional honestly named hygiene check | M0-F03 |
| `test` | two JSON property assertions | package TypeScript unit/fixture suites | M0-F04, scaffold test removed once covered |
| `typecheck` | parses JSON files | strict no-emit TypeScript project check | M0-F03 |
| `build` | checks scaffold paths and forbidden YAML | dependency-ordered TypeScript package builds | M0-F03; retain forbidden `.devspace.yml` policy only in a specifically named architecture check if still required |
| `contracts:check` | scaffold file-presence check | generated contract drift, registry completeness, and fixture validation | M0-F09/M0-F10 |
| `schema:check` | parses JSON | Project Options generated-schema drift plus valid/invalid fixture validation | M0-F07 |
| `db:migrate:test` | scaffold file-presence check | temporary SQLite empty/current/upgrade/newer-version migration suite | M0-F13 |

## Critical review: contradictions, questions, and blockers

### M0-F01 blocker closure

All eight material foundation blockers identified by the initial audit are closed for subsequent Milestone 0 work:

1. Project Options v1 now separates project-row General metadata from immutable runtime revisions and defines the complete runtime field set, workspace-scoped named volumes, development/service container settings, defaults, strictness, collection semantics, refinements, and generated-schema boundary. The existing hand-authored JSON Schema remains unchanged until M0-F07 regenerates it from Zod.
2. RFC 8785/JCS canonicalization, domain-separated SHA-256 input, and the `sha256-jcs-v1:<lowercase hex>` representation are specified.
3. Agent transport is REST-style HTTP/1.1 plus JSON over the Unix socket under `/v1`; it is not JSON-RPC.
4. Per-boot event sequencing, the cursor-only zero boundary, retained same-boot replay, and snapshot-required recovery are specified.
5. IDs, timestamps, hashes, JSON storage, and every closed state/kind/source/protocol value in the database model are specified.
6. Partial indexes provide at-most-one guarantees; future web-owned finalization and activation transactions provide eventual exactly-one invariants for ready projects.
7. Web-owned SQLite operations, the agent's narrow durable execution journal, operation/workspace-service/runtime-stack desired states, and explicit lost/recovery lifecycle graphs are specified.
8. The project model policy is present and every task now names Luna XHigh or Sol Medium, with Sol High/Max reserved for a failed focused Sol Medium attempt and Sol Ultra prohibited.

The remaining deferrals are intentional milestone boundaries, not representation blockers: runtime-plan compilation waits for Milestone 1; the Caddy package waits for the preview milestone; `testkit` waits for M0-F04; generated schemas, migrations, and executable contracts wait for their implementation tasks.

### Ownership contradictions or missing ownership decisions

1. `AGENTS.md` assigns `packages/database` “schema and migrations; no runtime operations,” while `packages/database/README.md` also claims repositories. Recommendation: keep repositories/application transactions in `apps/web`; update the package README in the implementation slice. This preserves web-only writes and prevents the agent from acquiring a database-capable package.
2. `packages/domain` claims IDs, while `packages/contracts` necessarily validates wire IDs and the database stores them. Recommendation: domain owns the semantic ID constructors/brands and contracts owns versioned wire schemas that consume them; database stores their decided text representation without becoming the ID authority.
3. The source of Project Options truth is unclear between the hand-authored root JSON Schema and the future runtime validator. Recommendation: `packages/project-options` owns one executable schema; `schemas/project-options-v1.schema.json` is a committed generated portability artifact.
4. `packages/testkit` is not created by M0-F02. M0-F04 may create it for JSON fixtures and temporary SQLite/path helpers only; fake-agent and temporary-Git facilities wait for a milestone that consumes them.

### Undesirable coupling to avoid

- Do not make contracts depend on database tables or Drizzle types; wire compatibility must not change with persistence layout.
- Do not make database depend on full contract schemas; persist selected primitives/JSON with explicit boundaries.
- Do not make contracts depend on Project Options in Milestone 0; each package owns and generates its versioned schemas independently.
- Do not put Project Options in domain or a generic common package; it owns its versioned model and generated schema.
- Do not make production packages import `testkit`, test-runner APIs, Drizzle Kit, or schema-generation CLIs at runtime.
- Do not add a task orchestrator, web framework, browser framework, HTTP framework, Docker client, Git library, PTY library, or Caddy client merely to make the scaffold look executable.
- Do not use JSON Schema validation as the only defense for cross-field policy, or duplicate a second hand-maintained schema beside runtime validators.

### Work assigned to the wrong milestone

- Actual runtime-plan compilation belongs to Milestone 1 activation, despite the `project-options` README and architecture describing its future ownership. Milestone 0 should define/validate configuration and, if necessary, the plan contract—not compile executable plans.
- The Caddy adapter belongs to the preview milestone. `packages/gateway-caddy` is not made an executable workspace package in Milestone 0.
- Fake agent, temporary Git repositories, repository inspection, canonical filesystem handle operations, and symlink-safe mutation belong with Milestone 1 agent behavior, not this foundation.
- Runtime-policy enforcement against Docker, process/terminal framing implementations, preview routing, and AI CLI behavior remain in their documented later milestones. Their wire schemas may exist in v1, but there must be no handlers.
- Cloudflare integration is deployment/product work and is not required for the Milestone 0 executable TypeScript foundation.

### Orchestration sources

The workflow, current-task record, and handoff templates referenced by `docs/README.md` are present. No missing orchestration source blocks the grouped M0-F02 through M0-F04 implementation chat.

## Milestone 0 final review checklist

- All packages are real pnpm importers and the lockfile is frozen-installable.
- App packages contain build scaffolding only, with no product behavior.
- TypeScript, lint, test, build, contract, schema, and migration commands invoke real tools and fail on representative defects.
- Project Options v1 has one runtime source, strict parser, canonical form/hash, generated JSON Schema, and valid/invalid/golden fixtures.
- Domain transitions are pure, exhaustive, tested, and demonstrably match every specified graph.
- Agent v1 requests, responses, errors, and events are strict/versioned/generated/fixture-tested, with no transport implementation.
- Drizzle definitions and committed forward migrations reflect the accepted database spec; only the future web app is authorized to write.
- Empty, already-current, prefix-upgrade, and newer-version migration scenarios use temporary SQLite files.
- Security helpers are pure foundations and do not claim repository discovery, symlink-safe mutation, DNS, or runtime enforcement.
- No runtime plan compiler, Git/Docker/process/terminal/preview/Caddy/Cloudflare/AI behavior appears in the diff.
- Placeholder scripts are gone or renamed so no command overstates what it checks.
- `docs/current-state.md` is updated after every meaningful implementation slice.
- The exact clean-clone command sequence passes and leaves the checkout clean.

## Recommended first implementation task

M0-F01 is complete. Execute **M0-F02 through M0-F04 in the next grouped implementation chat**, retaining a separate diff and check boundary for each numbered task. M0-F02 remains limited to manifests, corrected dependency direction, and buildable empty entry points; M0-F03 adds TypeScript/lint foundations; M0-F04 creates the test harness and only then creates `packages/testkit`. None may add product behavior.
