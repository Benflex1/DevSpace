# Current State

## Current milestone

Milestone 0 — foundation closure.

## Completed

- Real pnpm/TypeScript workspace and quality tooling.
- Domain lifecycle foundation and security validation foundation.
- Project Options v1 validation, canonicalization, and revision hashing.
- Agent API F09/F10 executable contracts and generated contract checks.
- Database contract ready for implementation, including the 13-table inventory, explicit
  timestamp/FK behavior, and operation identity rules.
- Complete executable database foundation: 13-table Drizzle schema, committed initial SQLite
  migration, read-only drift verification, narrow newer-version-aware migrator, and real
  temporary-file migration/constraint tests.
- Durable architecture, security model, roadmap, specifications, and accepted ADRs.

## Not implemented yet

- No usable web UI.
- No Agent transport or runtime.
- No Git/worktree runtime.
- No Docker workspace runtime.
- No terminals, tasks, previews, or AI product behavior.

## Remaining M0 work

- Final CI/clean-clone integration.
- M0 documentation and status cleanup.

## Next product objective

After M0, development switches to vertical product slices. The first objective is a usable
primary-workspace flow crossing Web, DB, Agent, Git, container runtime, terminal/task execution,
and preview functionality rather than completing each subsystem horizontally.
