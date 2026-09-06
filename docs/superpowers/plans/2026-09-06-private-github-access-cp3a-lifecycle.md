# CP3A connection lifecycle implementation plan

## Goal

Implement a reviewable, owner-only lifecycle and generation fence for the existing CP2 GitHub App
connection. Disconnect must block new private authority, settle already bounded work, clean only
the exact Agent connection state, and preserve every local project/workspace artifact. Reconnect
and reinstall must reuse the same DevSpace `connectionId` and use generation CAS.

## Architecture

- Keep `github_connection_attempts` as the original actor ownership anchor.
- Add lifecycle generation/state/cleanup/failure fields to `github_connections` and a separate
  actor-owned reauthorization-attempt table so pending setup cannot hide a retained connection.
- Add an Agent lifecycle tombstone under `github-app/lifecycle/`; preserve global App config/key,
  leases, and exact-file security checks.
- Thread expected generation as authorization context through Agent GitHub operations and managed
  source operations. Keep source identity as `connectionId + repositoryId`.
- Add dedicated Agent lifecycle endpoints and Web disconnect/reconnect routes without adding a
  projectless row to the global operation journal.

## Tech Stack

TypeScript, Zod contracts, Drizzle ORM with SQLite forward migrations, Node filesystem primitives,
the existing bounded GitHub transport/token lease implementation, Next.js route handlers, React
connection card, Vitest, pnpm repository checks, and the repository Semgrep CE gate.

## Spec

[CP3A design](../specs/2026-09-06-private-github-access-cp3a-design.md)

## Tasks

- [ ] **1. Add failing contract and database tests.** Add red tests for lifecycle enums and
  generation defaults, CP2 migration compatibility, actor ownership, pending reauthorization
  visibility, monotonic disconnect/reconnect CAS, and project source retention. Run the focused
  contract/database tests and record the expected failures.
- [ ] **2. Implement the schema and migration.** Add the lifecycle columns, reauthorization table,
  checks, indexes, migration SQL, journal, and snapshot. Update database interfaces and state
  selection so retained connections remain visible beside pending setup attempts. Make the tests
  from task 1 pass and run `pnpm db:migrate:test` and `pnpm db:check`.
- [ ] **3. Add failing Agent lifecycle/admission tests.** Cover CP2 binding defaults, generation
  monotonicity, stale generation refusal, disconnect before mint, disconnect racing mint, bounded
  settlement after Git launch, exact cleanup isolation, cleanup crash/restart, lease-blocked
  reconnect, stale refresh/callback, and all external authority classifications.
- [ ] **4. Implement Agent lifecycle state and authority classification.** Add exact lifecycle
  tombstone read/write/reconciliation, short admission synchronization, disabled fencing, safe
  generation CAS, reconnect preparation, exact binding unlink, token cleanup after disconnect,
  and authoritative-vs-transient error mapping. Preserve bounded token/Git behavior and CP2
  binding compatibility.
- [ ] **5. Extend contracts and Agent/Web clients.** Add generation context, lifecycle endpoint
  descriptors, bounded error codes/reasons, response fields, and generated/inventory coverage.
  Add Agent server dispatch/error mapping and client methods. Add generation propagation to managed
  inspect, clone, fetch, resolve, list, refresh, and verify paths.
- [ ] **6. Add Web lifecycle transactions and routes.** Add database-backed disconnect fencing and
  completion/degradation recording, reauthorization attempt creation/claim/CAS, failure recording,
  and actor-owned generation admission. Add authenticated CSRF-protected disconnect and reconnect
  routes. Ensure Agent-unavailable disconnect remains pending/degraded and never re-enables access.
- [ ] **7. Update the minimal browser flow.** Preserve retained connection views when a setup attempt
  is pending; add confirmation-gated Disconnect and Reconnect/re-authorize actions; display safe
  lifecycle and authority-loss guidance; avoid exposing paths, tokens, installation credentials, or
  raw upstream data. Update UI assertions.
- [ ] **8. Add composition and retention tests.** Exercise real Web/Agent/database seams for
  private operation refusal while disconnected, same-ID reconnect, new installation ID repair,
  repository-ID rename behavior, local project/workspace retention, and pending setup visibility.
  Do not add push behavior or modify the global operation lifecycle.
- [ ] **9. Close documentation and failure-policy inventories.** Correct CP2 merge and real-provider
  acceptance facts in current state/roadmap/spec/security/architecture docs, document CP3A lifecycle
  behavior and the concise CP3B deferred boundary, and update diagnostics/failure-policy mappings.
- [ ] **10. Verify and commit.** Run focused suites followed by the complete repository gate,
  `git diff --check origin/main...HEAD`, and Semgrep CE when Docker is available. Self-review the
  diff for authority boundaries, exact cleanup, local-state retention, and no CP3B artifacts. Make
  intentional local commits, leave the branch clean, and do not push, open a PR, merge, or deploy.

## Test-first checkpoints

Production code starts only after the red tests in tasks 1 and 3 demonstrate the missing behavior.
Each implementation task is followed by the smallest focused green test command before moving to
the next boundary. The final verification command output is recorded in the completion response.
