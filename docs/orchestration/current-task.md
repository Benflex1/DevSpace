# Current Task

## Status

M0-F02 completed on 2026-07-14.

## Completed task

Create the real pnpm 11 workspace and the accepted Milestone 0 app/package boundaries without adding product behavior.

## Deliverables

- Node.js and pnpm baselines are checked in through the root engine range, `.nvmrc`, and `packageManager` field.
- `apps/web`, `apps/agent`, and the five required production packages have private ESM manifests and empty source roots.
- Library packages expose future `dist/` entry points; application packages remain private executable boundaries.
- Internal production dependencies use `workspace:*` and follow the accepted ownership graph.
- `tooling/check-workspace-graph.mjs` checks expected and deferred package manifests, dependency direction, unknown internal packages, application edges, and cycles.
- Line-ending policy and package ownership README corrections are recorded.

## Previous completed task

M0-F01 correction review completed on 2026-07-14.

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

Continue with M0-F03: add shared strict TypeScript build and semantic lint configuration. M0-F04 remains pending; create `packages/testkit` only when that task consumes it. Do not begin M0-F05 or product behavior.
