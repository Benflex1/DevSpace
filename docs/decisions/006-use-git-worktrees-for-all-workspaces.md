# ADR 006: Keep each workspace's Git repository self-contained

- Status: Accepted

## Context
The workspace container mounts only its source directory and private harness-home slot. A Git
worktree whose administration directory and common object store live in the Agent's shared bare
repository cannot resolve Git metadata in the container. Mounting that store would expose shared
refs and objects across workspaces and bring Agent-private state into the container boundary.

## Decision
Keep the Agent-managed bare repository as the authenticated fetch cache and seed source. Give each
workspace a complete, independent Git repository under its source directory, addressed by the
relative `.git` pointer `gitdir: .devspace-git`. Copy Git objects; do not use alternates or
hardlinks. Workspace-local refs and commits are shared by the Agent and that workspace's container,
and are not shared with sibling workspaces. The container receives no mount of the bare store or
Agent state.

The Agent remains the authority for authenticated GitHub Fetch and Push. Fetch updates each
workspace's `origin` remote-tracking refs from the managed bare cache. Push revalidates the
workspace's currently inspected branch and commit against the captured request and uses the
Agent-held short-lived credential. A workspace may switch or create local branches; the recorded
creation branch remains validated as provenance.

Existing v1 worktree repositories migrate on Start only after the runtime confirms the container is
stopped or absent. Migration builds and validates the independent repository before atomically
changing `.git`. It retains local commits, staged content, working files, untracked files, and local
Git identity. Unsupported or ambiguous states, including an unmerged index or a conflicting
reserved metadata path, fail with the original repository available for recovery.

## Consequences
Primary and isolated workspaces share one lifecycle and container mount model. Git metadata survives
normal container stop/start and recreation with the workspace files. Browser file APIs hide and deny
`.devspace-git`. Workspace-local Git operations no longer depend on Agent-host paths, while refs,
objects, unpublished commits, and credentials remain isolated from sibling workspaces.
