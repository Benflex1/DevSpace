# Current State

## Current milestone

Milestone 0 — Architecture and contracts.

## What is settled

- container-first architecture;
- dedicated rootless Docker daemon under a dedicated Unix account;
- one primary workspace per project plus optional isolated workspaces;
- every workspace uses a Git worktree and independent container stack;
- UI-managed, database-versioned Project Options; no required YAML;
- Cloudflare Access for control and preview ingress;
- web/agent Unix socket;
- web is sole SQLite writer;
- Caddy preview gateway;
- terminal-first AI sessions;
- trusted owner-controlled repository threat model.

## What exists

- documentation and repository scaffold only;
- Project Options v1 schema;
- architecture, threat model, database, API, lifecycle, roadmap, and ADR drafts.

## What does not exist

- no web application implementation;
- no agent implementation;
- no Docker integration;
- no database migrations;
- no terminals, tasks, previews, worktree mutation, or AI sessions.

## Next task

Create the actual pnpm workspace tooling and contract-test harness without implementing product behavior. Then implement Milestone 1 slice 1: global settings model.
