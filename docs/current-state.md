# Current State

## Current milestone

Milestone 0 — Architecture and contracts.

## What is settled

- Node.js 24 LTS, pnpm 11, and ESM as the foundation baseline;
- Zod runtime schemas as the executable source of truth and generated JSON Schema draft 2020-12 artifacts;
- canonical lowercase UUIDv7 IDs and RFC 3339 UTC millisecond timestamps;
- RFC 8785/JCS canonicalization and versioned SHA-256 lowercase-hex hashes;
- REST-style HTTP plus JSON over the agent Unix socket under `/v1`;
- per-boot agent event cursors with a cursor-only zero boundary and snapshot-and-resubscribe recovery;
- container-first architecture;
- dedicated rootless Docker daemon under a dedicated Unix account;
- one primary workspace per project plus optional isolated workspaces;
- every workspace uses a Git worktree and independent container stack;
- UI-managed Project Options with project General metadata authoritative on `projects` and immutable runtime-configuration revisions; no required YAML;
- Cloudflare Access for control and preview ingress;
- web/agent Unix socket;
- web is sole SQLite writer;
- web-owned operation records plus a narrow agent runtime execution/idempotency journal outside SQLite;
- Caddy preview gateway;
- terminal-first AI sessions;
- trusted owner-controlled repository threat model.

## What exists

- documentation, repository scaffold, pure domain lifecycle implementation, accepted M0-F06 pure
  security-validation implementation, accepted M0-F07 Project Options schema contract, and the
  in-progress M0-F08 canonicalization and hashing slice;
- a pnpm workspace with the seven Milestone 0 app/package boundaries, empty ESM source roots, and a dependency-graph invariant check;
- strict TypeScript typecheck/build configurations and semantic flat-config ESLint for all eight active workspaces, with generated output kept ignored;
- clean-clone cross-package typechecking resolves public workspace imports to source entry points through a shared no-emit TypeScript topology; production builds remain project-reference based;
- a Vitest-based TypeScript unit-test harness with eight named Node projects, deterministic non-watch execution, test typechecking, optional V8 coverage, and source-resolved public workspace imports;
- the private development-only `@devspace/testkit` package with temporary-directory and JSON-fixture helpers, including substantive utility tests;
- all 17 complete Milestone 0 lifecycle graphs represented by closed TypeScript state unions, private runtime-frozen transition definitions, lifecycle-specific pure transition functions, and stable discriminated errors;
- specification-derived tests independently encode every state, edge, terminal state, and expected count, so an accidental production-edge addition or removal fails parity testing across all 690 ordered pairs;
- pure contextual lifecycle guards for project readiness, operation cancellation, isolated-workspace dirty protection, positive lost-state recovery evidence, runtime-stack absence confirmation, service/stack ownership, service health, and preview route presence, with every guarded edge and invalid-edge precedence covered;
- side-effect-free typed security validators for distinct worktree-relative path policies,
  claimed canonical absolute POSIX path relations, Git branch shorthand, lower-case ASCII DNS
  labels and approved bases, and one-label preview-pattern composition;
- constructor-created approved preview bases bind IDs to domains with private runtime/type
  identity; composition resolves exact IDs only through an opaque snapshotted package-owned
  registry, rejects duplicates and structural forgeries, and defensively revalidates the selected
  domain;
- fully reflected copied-symbol approved-base forgeries are covered by a permanent regression;
- branded security values remain serializable strings, expected failures return immutable
  discriminated results with stable structured error codes, and package tests cover hostile POSIX
  and Windows path spellings on Linux without filesystem or Git access;
- workspace graph and ESLint boundaries require testkit's exact `workspace:*` devDependency, public imports from test-only files, and real source consumption; deep imports and production imports are rejected;
- ESLint regression coverage exercises deep, undeclared, production-source, and legitimate TypeScript import-type testkit imports;
- strict Project Options v1 Zod source and inferred types covering runtime configuration only;
- Project Options v1 parser defaults, nested strictness, security-policy adapters, local
  cross-reference validation, and generated draft 2020-12 JSON Schema with byte-level drift check;
- package-owned RFC 8785/JCS text and UTF-8 canonicalization with an explicit JSON-value boundary,
  Project Options collection normalization, domain-separated SHA-256 revision hashing, and a
  checked-in golden canonical/hash fixture;
- closed Project Options, database, lifecycle, and agent transport specifications for Milestone 0 implementation, including complete workspace container configuration and zero-event cursor semantics;
- accepted foundation-representations ADR 013;
- architecture, threat model, roadmap, and accepted ADR set.

## What does not exist

- no web application implementation;
- no agent implementation;
- no Docker integration;
- no database migrations;
- no terminals, tasks, previews, worktree mutation, or AI sessions.

## Next task

Complete the M0-F08 canonicalization and hashing review. F07 is accepted and committed as
`66c3f2d`. F08 is implemented but is not accepted or committed. F09 agent contracts and all
later-milestone runtime work remain out of scope.
