# Codex Task Prompt Template

Use this template for an implementation or planning task. Remove sections that genuinely do not apply, but keep the scope, non-goals, acceptance criteria, checks, and output contract.

```text
You are working in the DevSpace repository.

Read first:
- AGENTS.md
- docs/current-state.md
- <relevant ADRs/specifications>

Goal:
<One observable outcome.>

Current state:
<Only facts needed for this task. Tell Codex to verify them in the repository.>

Allowed scope:
- <packages/directories that may change>
- <specific behavior that may be added or modified>

Non-goals:
- <related work that must not be implemented>
- Do not continue to the next roadmap slice.
- Do not redesign accepted architecture or ADRs.

Requirements:
1. <Requirement>
2. <Requirement>

Security and architecture constraints:
- <Relevant invariant from AGENTS.md/ADR>
- <Relevant trust boundary>

Acceptance criteria:
- <Observable or testable proof>
- <Observable or testable proof>

Required checks:
- <narrow tests>
- pnpm lint
- pnpm typecheck
- pnpm test
- git diff --check

Working method:
1. Inspect the relevant repository state and documents before editing.
2. Briefly state the implementation approach and any ambiguity you resolved.
3. Implement the smallest complete slice.
4. Add or update tests.
5. Run the required checks.
6. Review the final diff for scope creep and accidental changes.
7. Update docs/current-state.md only if the repository's actual capabilities or next task changed.

Stop conditions:
- Stop and report if the task conflicts with an accepted ADR, requires a prohibited shortcut, or cannot be safely verified.
- Do not invent a broader architecture to bypass a blocker.

Final response:
Use docs/templates/codex-session-handoff.md. Include changed files, decisions, checks with exact results, risks, and the recommended next task. Do not claim checks passed unless you ran them.
```
