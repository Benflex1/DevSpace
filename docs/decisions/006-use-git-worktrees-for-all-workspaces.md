# ADR 006: Use Git worktrees for primary and isolated workspaces

- Status: Accepted


## Context
Using a normal checkout for the primary workspace and worktrees only for extras creates two code paths.

## Decision
Keep a managed repository store and represent every editable workspace as a Git worktree.

## Consequences
Primary and isolated workspaces share one lifecycle model. The repository store is never edited directly.
