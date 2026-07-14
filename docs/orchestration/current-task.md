# Current Task

## Status

M0-F03 completed on 2026-07-14.

## Completed task

Establish real strict TypeScript compilation, package builds, and semantic linting without adding product behavior or a test framework.

## Deliverables

- Root and package TypeScript configurations preserve strictness, use NodeNext ESM, and separate no-emit typechecking from emitting composite builds.
- No-emit typechecking uses public-package-to-source `paths` mappings so cross-package imports work from a clean checkout without prior `dist/` output.
- All seven active packages have real `typecheck` and `build` scripts; root commands invoke every package explicitly in dependency-safe order.
- Library and application builds emit ESM JavaScript, declarations, source maps, and declaration maps to ignored `dist/` directories.
- Flat-config ESLint uses official JavaScript recommendations, type-aware TypeScript rules, Node globals, zero warnings, ESM-only checks, and accepted source-import boundaries.
- Root lint preserves workspace-graph and text-hygiene checks.
- Only the requested development tooling dependencies were added; no test framework or runtime dependency was added.

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

Continue with M0-F04: establish the unit-test and fixture harness. Create `packages/testkit` only when that task consumes it. Do not begin M0-F05 or product behavior.
