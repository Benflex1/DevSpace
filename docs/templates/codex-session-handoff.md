# Codex Session Handoff Template

Codex should use this structure at the end of every task.

```text
## Outcome
- Completed / Partially completed / Blocked
- One-paragraph description of the actual result

## Changed files
- path: purpose

## Decisions made
- Decision and why it was necessary
- State whether an ADR or specification was changed

## Tests and checks
- command — PASS/FAIL/NOT RUN
- Include relevant failure details; do not only give a summary

## Manual verification
- What was verified manually
- What could not be verified in this environment

## Risks and follow-ups
- Remaining technical risk
- Deferred work that is explicitly outside this task

## Repository state
- Branch
- git status --short
- Commit created: yes/no; include hash only if actually committed

## Recommended next task
- The smallest independently testable next slice
```
