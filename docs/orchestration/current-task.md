# Current Task

## Status

M0-F10 recovery contracts are accepted and committed at
`70fad658e15930e434f57cfcfb6736a0e395693d`. The first M0-F11 implementation attempt correctly
stopped before production changes because database-v1 left timestamp nullability and foreign-key
actions implicit and retained stale operation idempotency/request-hash language. The current
uncommitted slice corrects only those database specification blockers.

## Specification-correction deliverables

- explicit `NOT NULL` or nullable status for every persisted timestamp in all 13 accepted tables;
- one normative 24-row foreign-key matrix with required/nullable status, `ON DELETE`, universal
  `ON UPDATE NO ACTION`, and ownership/reference rationale;
- cascades limited to strict project/workspace ownership paths, protected required references
  using `RESTRICT`, and nullable retained context using `SET NULL`;
- `operations.operation_id` as the sole public idempotency identity, required project ownership,
  optional workspace context, and the stable F09 `operation_name`;
- removal of stale Web SQLite/public `idempotency_key` and `request_hash` fields while preserving
  the Agent journal's private fingerprint boundary;
- unchanged 13-table inventory and unchanged three at-most-one partial uniqueness invariants.

## Scope boundary

This is documentation-only specification correction. It adds no Drizzle schema, source code,
manifest or lockfile change, migration, test, generated artifact, runtime persistence, Agent
journal storage, F10 event/snapshot persistence, or F12/F13 work.

## Next task

Review and accept the corrected database-v1 contract before restarting M0-F11 implementation.
