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

- documentation and repository scaffold only;
- Project Options v1 JSON Schema scaffold, pending regeneration from the future Zod source in M0-F07;
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

Run M0-F02 through M0-F04 as one grouped implementation chat: create the pnpm workspace/package boundaries, add TypeScript and lint foundations, then establish the test/fixture harness. Do not implement product behavior or begin Milestone 1.
