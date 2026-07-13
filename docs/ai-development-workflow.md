# AI Development Workflow

## Purpose

This document defines how DevSpace is developed with ChatGPT acting as the orchestrator and Codex acting as the implementation agent.

The goals are:

- preserve architecture and security decisions across AI sessions;
- keep each Codex task small, independently testable, and reviewable;
- minimize repeated context and unnecessary model usage;
- prevent broad agents from silently redesigning settled boundaries;
- maintain a reliable handoff when either ChatGPT or Codex starts a new conversation.

## Roles

### Human owner

The owner:

- decides product intent and approves architectural changes;
- runs Codex prompts supplied by the orchestrator;
- reviews visible behavior and destructive operations;
- returns Codex summaries, plans, failures, and relevant diffs to the orchestrator;
- decides whether a completed change is committed or discarded.

### ChatGPT orchestrator

The orchestrator:

- selects the next independently testable task;
- selects a model using the model policy below;
- writes the exact Codex prompt;
- reviews Codex's plan, summary, test results, and diff information;
- identifies scope creep, architectural violations, and missing tests;
- decides whether Codex should fix, revise, review, or stop;
- tells the owner when to start a new Codex or ChatGPT conversation;
- updates the project plan when new information changes sequencing.

The orchestrator does not assume a Codex task succeeded merely because its summary says so. Claims must be supported by tests, commands, and diff review.

### Codex implementation agent

Codex:

- reads `AGENTS.md` and the documents named in the task prompt;
- inspects the current repository instead of assuming file contents;
- stays within the exact allowed scope;
- implements or plans only the requested slice;
- runs required checks;
- reviews its own diff before finishing;
- updates `docs/current-state.md` only when behavior or project state materially changes;
- returns a structured handoff using `docs/templates/codex-session-handoff.md`.

Codex must not proceed into the next roadmap task unless explicitly prompted.

## Source-of-truth order

When documents disagree, use this order:

1. The current task prompt.
2. Accepted ADRs in `docs/decisions/`.
3. `docs/architecture.md` and `docs/security/threat-model.md`.
4. Versioned specifications in `docs/specs/`.
5. `DEVSPACE_HANDOFF_V2.md`.
6. `docs/roadmap.md`.
7. `docs/current-state.md`.
8. README files and code comments.

A task prompt may narrow scope but must not silently override an accepted ADR. Proposed ADR changes require a planning/review task before implementation.

## Standard task cycle

### 1. Select one slice

A slice should have:

- one observable goal;
- explicit allowed files or subsystems;
- explicit non-goals;
- acceptance criteria;
- required checks;
- a rollback boundary.

Avoid combining architecture, database, UI, runtime, and deployment work in one task unless the slice genuinely requires all of them.

### 2. Start from a checkpoint

Before Codex changes code:

- the working tree should be clean, or unrelated user changes must be identified;
- the current branch should match the eventual scope;
- the previous accepted slice should be committed;
- `docs/current-state.md` should describe the actual repository state.

Use `feat/...`, `fix/...`, `refactor/...`, `test/...`, or `chore/...` according to the eventual branch scope.

### 3. Plan only when useful

Require a separate plan before implementation when the task:

- changes an architectural boundary or ADR;
- affects authentication, authorization, secrets, container isolation, paths, migrations, or lifecycle reconciliation;
- spans several packages with unclear ownership;
- has multiple plausible approaches with meaningful tradeoffs;
- cannot be safely reversed in one small commit.

For a narrow, settled task, ask Codex to inspect, implement, test, and summarize in one run. Requiring a planning task for every small change wastes usage and creates stale documents.

### 4. Implement and verify

Codex must:

- inspect relevant code and documents first;
- implement only the named slice;
- add or update tests for changed behavior;
- run the narrowest useful checks during iteration;
- run all task-required checks before completion;
- run `git diff --check`;
- review the final diff for accidental changes and scope creep.

### 5. Orchestrator review

Return to the orchestrator:

- the complete Codex final response;
- any plan or design document Codex created;
- failing command output;
- `git status --short`;
- `git diff --stat`;
- the diff or relevant changed files when the change is non-trivial.

The orchestrator then chooses one of:

- accept and commit;
- request a targeted fix in the same Codex chat;
- request an independent review;
- discard or revert the slice;
- start a fresh chat with a corrected prompt.

### 6. Commit and update state

A completed slice should normally end in one intentional commit. The commit should include the implementation, tests, and corresponding current-state update.

Do not create a large pull request for a tiny documentation-only correction. Use a PR for substantial, reviewable changes or milestone integration.

## Model policy

Use the cheapest model that is likely to complete the task correctly.

| Work type | Recommended model |
|---|---|
| Commits, renames, formatting, tiny UI changes, small documentation edits | Luna Medium; Luna High if precision is important |
| Normal bug fix or clearly scoped feature | Luna XHigh |
| Unclear task requiring exploration across several repository areas | Terra Medium |
| Architecture, authentication, security boundaries, container runtime, database migrations, lifecycle/reconciliation | Sol Medium |
| Terra Medium or Sol Medium failed after one well-targeted correction | Sol High or Max |
| Sol Ultra | Never |

Do not escalate merely because a task is long. First reduce scope, clarify acceptance criteria, or start a clean chat.

## Codex chat rotation

Use one Codex chat for one coherent slice and its immediate fixes.

Keep the same chat when:

- correcting the implementation it just produced;
- answering a question about its own plan;
- fixing failing checks caused by that slice;
- performing one final self-review before commit.

Start a new Codex chat when:

- the previous slice is committed and the next slice changes subsystem or goal;
- moving between planning and a substantially different implementation phase;
- the current chat contains abandoned approaches or outdated assumptions;
- Codex repeatedly reintroduces reverted changes or confuses current state;
- the prompt would need a long explanation of what from the old chat is no longer valid;
- an independent review is desired.

A good default is two to four prompts per Codex chat:

1. implement or plan;
2. targeted correction;
3. optional review/fix;
4. final verification.

Do not keep a chat alive merely to avoid re-reading a few source files. Incorrect stale context usually costs more than a fresh inspection.

## ChatGPT orchestrator chat rotation

Start a new orchestrator conversation at a milestone boundary, after a major architecture change, or when the conversation has accumulated several completed slices and old implementation details.

Before rotating:

- update `docs/current-state.md`;
- update `docs/orchestration/current-task.md`;
- ensure accepted decisions are recorded as ADRs;
- attach or provide `DEVSPACE_HANDOFF_V2.md`, `docs/current-state.md`, `docs/roadmap.md`, and the current-task file to the new chat;
- include the latest Codex handoff and any unresolved failure output.

The orchestrator should explicitly tell the owner when rotation is recommended. Do not rotate in the middle of an uncommitted fix unless the current conversation is actively causing confusion.

## Context minimization

Codex does not need every document in every prompt.

Every implementation prompt should name:

- `AGENTS.md`;
- `docs/current-state.md`;
- the relevant ADRs/specifications;
- the exact code areas to inspect.

Only architecture/security tasks need the complete architecture and threat model. Tiny fixes should reference the exact affected module and tests.

Do not paste large documents into prompts when they already exist in the repository. Tell Codex which files are authoritative.

## Review strategy

Use three levels:

1. **Self-review:** always; Codex reviews its own diff and tests.
2. **Fresh Codex review:** for meaningful slices, use a new chat so the reviewer has no commitment to the implementation approach.
3. **Orchestrator architecture review:** required for boundaries, security, migrations, and roadmap changes.

A review prompt should ask for findings first. Do not allow the reviewer to edit unless explicitly requested.

## Stop conditions

Codex must stop and report rather than improvise when:

- an accepted ADR conflicts with the task;
- required repository state is missing;
- it discovers unrelated user changes that would be overwritten;
- a migration or destructive operation cannot be safely tested;
- fulfilling the request would require host Docker access, privileged containers, production mounts, or another prohibited shortcut;
- acceptance criteria cannot be verified in the available environment.

A stop report should include the exact blocker, evidence, and the smallest decision required from the orchestrator.
