# Current Task

## Status

M0-F01 correction review completed on 2026-07-14.

## Completed task

Close the material representation and specification blockers in the Milestone 0 foundation plan, including the four orchestration-review cross-specification corrections, without implementing product behavior or changing generated artifacts.

## Deliverables

- ADR 013 records the runtime, package-manager, ESM, schema-source, ID, timestamp, canonicalization, hashing, agent transport, and cursor-recovery decisions.
- Project Options v1 separates project General metadata from immutable runtime revisions and defines named volumes, complete development/service container configuration, declared-port preview validation, defaults, canonicalization, and runtime refinements.
- Database v1 makes the project row authoritative for project/repository metadata, the workspace row authoritative for workspace display names, and General edits optimistic through `projects.row_version`.
- Agent API v1 defines REST-over-UDS envelopes, web-created operation IDs, the agent's narrow durable execution/idempotency journal, request hashing, events beginning at sequence one, cursor-only sequence zero, replay, and snapshot recovery.
- Lifecycle v1 preserves web ownership of SQLite operation state while using the agent journal only for safe acceptance, replay, and recovery.
- The foundation plan now uses the project model policy, grouped chats, corrected package dependencies, deferred package creation, and Linux-only initial CI with hostile cross-platform path fixtures.

## Next implementation chat

Execute M0-F02 through M0-F04 in one grouped chat, with a separate review and verification boundary after each numbered task:

1. M0-F02: create the real pnpm workspace and intended package manifests using Node.js 24 LTS, pnpm 11, and ESM. Do not create `packages/testkit` or make `packages/gateway-caddy` an executable workspace package.
2. M0-F03: add shared strict TypeScript build and semantic lint configuration.
3. M0-F04: establish the test and fixture harness; create `packages/testkit` only when this task consumes it.

Use Luna XHigh for these clearly scoped implementation tasks. Do not begin M0-F05 or product behavior in that chat unless separately prompted after M0-F04 is accepted.
