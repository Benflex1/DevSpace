# DevSpace

DevSpace is a self-hosted, single-user, AI-first development control plane.

Every project receives a managed **primary workspace**. Each workspace runs inside its own rootless, containerized development stack. Optional isolated workspaces use Git worktrees and separate stacks for parallel or experimental work.

This repository is currently at **Milestone 0: architecture and contracts**. It intentionally contains no feature implementation.

## Milestone 0 source of truth

- `DEVSPACE_HANDOFF_V2.md`
- `docs/architecture.md`
- `docs/security/threat-model.md`
- `docs/specs/project-options-v1.md`
- `docs/specs/database-v1.md`
- `docs/specs/agent-api-v1.md`
- `docs/specs/lifecycle-states.md`
- `docs/roadmap.md`
- `docs/decisions/`

## Product boundary

DevSpace is not a browser IDE, general Docker manager, deployment platform, Coolify replacement, multi-user SaaS, or hostile-code sandbox.

## Current status

Architecture decisions are recorded. The next implementation milestone is a narrow foundation slice: configuration revisions, project registration, managed repository storage, a primary worktree, and a stopped workspace runtime record. No task execution, terminals, previews, or AI sessions belong in that first slice.
