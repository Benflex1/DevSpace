# Current Task

## Status

M0-F05 review corrections implemented on 2026-07-14; focused re-review pending.

## Completed task

Implement the complete pure Milestone 0 domain lifecycle state machines without adding orchestration, persistence, runtime operations, or M0-F06 security primitives.

## Deliverables

- Closed state unions and private, deeply frozen exhaustive transition definitions cover project, configuration revision, operation, workspace desired/observed, runtime-stack desired/observed, workspace-service desired/observed/health, process desired/observed, terminal, preview desired/observed, AI session, and task run.
- Public lifecycle-specific transition functions return immutable discriminated results with stable invalid-edge and contextual-guard error codes.
- Project readiness, cancellation capability, isolated-workspace dirty handling, lost recovery evidence, runtime absence confirmation, service ownership, health validity, and preview route-presence rules are pure typed guards or invariants.
- Specification-derived fixtures independently encode all 17 state sets, 245 allowed edges, 445 rejected pairs, exact terminal states, and all 690 ordered pairs; accidental production-edge additions and removals fail naturally.
- Independent guarded-edge fixtures cover every guarded edge with required positive and negative context, plus invalid-edge precedence for every guard family.
- Package-root and type-level regression checks prevent production transition-table exports; internal table construction freezes the top-level table and every copied destination collection.
- Desired and observed state APIs remain separate; no self-transition, shortcut, implicit recovery, persistence, orchestration, runtime access, or executable behavior was introduced.

## Previous completed task

M0-F04 completed on 2026-07-14.

## Completed task

Establish the real TypeScript unit-test and fixture harness without adding product behavior or beginning lifecycle, security, Project Options, contracts, or database implementation.

## Deliverables

- Vitest 4 named-project configuration runs all eight active workspaces in deterministic Node mode through non-watch `vitest run`.
- Every active workspace has explicit no-emit test typechecking; package builds exclude test files from `dist/`.
- Private development-only `@devspace/testkit` provides tested temporary-directory and JSON-fixture helpers.
- Workspace graph and ESLint checks enforce testkit dependency and import boundaries.
- V8 coverage is available through `test:coverage` and writes only to ignored output.

## Previous completed task

M0-F03 completed on 2026-07-14.

## Completed task

Establish real strict TypeScript compilation, package builds, and semantic linting without adding product behavior or a test framework.

## Deliverables

- Root and package TypeScript configurations preserve strictness, use NodeNext ESM, and separate no-emit typechecking from emitting composite builds.
- No-emit typechecking uses public-package-to-source path mappings so cross-package imports work without prior build output.
- All active packages have real typecheck and build scripts; production builds emit ESM JavaScript and declarations without test files.
- Flat-config ESLint uses type-aware TypeScript rules, ESM checks, and accepted source-import boundaries.

## Previous completed task

M0-F02 completed on 2026-07-14.

## M0-F02 deliverables

Create the real pnpm 11 workspace and the accepted Milestone 0 app/package boundaries without adding product behavior.

### Recorded outcomes

- Node.js and pnpm baselines are checked in through the root engine range, `.nvmrc`, and `packageManager` field.
- `apps/web`, `apps/agent`, and the five required production packages have private ESM manifests and empty source roots.
- Library packages expose future `dist/` entry points; application packages remain private executable boundaries.
- Internal production dependencies use `workspace:*` and follow the accepted ownership graph.
- `tooling/check-workspace-graph.mjs` checks expected and deferred package manifests, dependency direction, unknown internal packages, application edges, and cycles.
- Line-ending policy and package ownership README corrections are recorded.

## M0-F01 deliverables

Close the material representation and specification blockers in the Milestone 0 foundation plan, including the four orchestration-review cross-specification corrections, without implementing product behavior or changing generated artifacts.

### Recorded outcomes

- ADR 013 records the runtime, package-manager, ESM, schema-source, ID, timestamp, canonicalization, hashing, agent transport, and cursor-recovery decisions.
- Project Options v1 separates project General metadata from immutable runtime revisions and defines named volumes, complete development/service container configuration, declared-port preview validation, defaults, canonicalization, and runtime refinements.
- Database v1 makes the project row authoritative for project/repository metadata, the workspace row authoritative for workspace display names, and General edits optimistic through `projects.row_version`.
- Agent API v1 defines REST-over-UDS envelopes, web-created operation IDs, the agent's narrow durable execution/idempotency journal, request hashing, events beginning at sequence one, cursor-only sequence zero, replay, and snapshot recovery.
- Lifecycle v1 preserves web ownership of SQLite operation state while using the agent journal only for safe acceptance, replay, and recovery.
- The foundation plan now uses the project model policy, grouped chats, corrected package dependencies, deferred package creation, and Linux-only initial CI with hostile cross-platform path fixtures.

## Next task in this chat

Focused independent re-review of the M0-F05 corrections. Do not begin M0-F06 yet.
